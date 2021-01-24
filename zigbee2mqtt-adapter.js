/**
 * zigbee2mqtt-adapter.js - Adapter to use all those zigbee devices via
 * zigbee2mqtt.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

'use strict';

const mqtt = require('mqtt');
const { Adapter, Device, Property, Event } = require('gateway-addon');

const Devices = require('./devices');
const ExposesDeviceGenerator = require('./ExposesDeviceGenerator');

const identity = v => v;

class MqttProperty extends Property {
  constructor(device, name, propertyDescription) {
    super(device, name, propertyDescription);
    this.setCachedValue(propertyDescription.value);
    this.device.notifyPropertyChanged(this);
    this.options = propertyDescription;
  }

  setValue(value) {
    return new Promise((resolve, reject) => {
      super
        .setValue(value)
        .then(updatedValue => {
          const { toMqtt = identity } = this.options;
          this.device.adapter.publishMessage(`${this.device.id}/set`, {
            [this.name]: toMqtt(updatedValue),
          });
          resolve(updatedValue);
          this.device.notifyPropertyChanged(this);
        })
        .catch(err => {
          reject(err);
        });
    });
  }
}

class MqttDevice extends Device {
  constructor(adapter, id, modelId, description) {
    super(adapter, id);
    this.name = description.name;
    this['@type'] = description['@type'];
    this.modelId = modelId;
    for (const [name, desc] of Object.entries(description.actions || {})) {
      this.addAction(name, desc);
    }
    for (const [name, desc] of Object.entries(description.properties || {})) {
      const property = new MqttProperty(this, name, desc);
      this.properties.set(name, property);
    }
    for (const [name, desc] of Object.entries(description.events || {})) {
      this.addEvent(name, desc);
    }
  }

  performAction(action) {
    return new Promise((resolve, reject) => {
      action.start();
      this.adapter.publishMessage(`${this.id}/set`, {
        [action.name]: action.input
      });
      action.finish();
    });
  }
}

class ZigbeeMqttAdapter extends Adapter {
  constructor(addonManager, manifest) {
    super(addonManager, 'ZigbeeMqttAdapter', manifest.name);
    this.config = manifest.moziot.config;
    addonManager.addAdapter(this);
    this.exposesDeviceGenerator = new ExposesDeviceGenerator();

    this.client = mqtt.connect(this.config.mqtt);
    this.client.on('error', error => console.error('mqtt error', error));
    this.client.on('message', this.handleIncomingMessage.bind(this));
    this.client.subscribe(`${this.config.prefix}/bridge/devices`);
  }

  handleIncomingMessage(topic, data) {
    const msg = JSON.parse(data.toString());
    if (topic.startsWith(`${this.config.prefix}/bridge/devices`)) {
      for (const device of msg) {
        this.addDevice(device);
      }
    }
    if (!topic.startsWith(`${this.config.prefix}/bridge`)) {
      const friendlyName = topic.replace(`${this.config.prefix}/`, '');
      const device = this.getDevice(friendlyName);
      if (!device) {
        return;
      }
      if (msg.action && device.events.get(msg.action)) {
        const event = new Event(
          device,
          msg.action,
          msg[device.events.get(msg.action)],
        );
        device.eventNotify(event);
      }
      for (const key of Object.keys(msg)) {
        const property = device.findProperty(key);
        if (!property) {
          continue;
        }
        const { fromMqtt = identity } = property.options;
        property.setCachedValue(fromMqtt(msg[key]));
        device.notifyPropertyChanged(property);
      }
    }
  }

  publishMessage(topic, msg) {
    this.client.publish(`${this.config.prefix}/${topic}`, JSON.stringify(msg));
  }

  addDevice(info) {
    const existingDevice = this.getDevice(info.friendly_name);
    if (existingDevice && existingDevice.modelId === info.model_id) {
      console.info(`Device ${info.friendly_name} already exists`)
      return;
    }

    let deviceDefinition = Devices[info.model_id]; // devices.js

    if (!deviceDefinition) {
      const detectedDevice = this.exposesDeviceGenerator.generateDevice(info);
      if (detectedDevice) {
        deviceDefinition = detectedDevice;
        console.info(`Device ${info.friendly_name} created from Exposes API`)
      }
    } else {
      console.info(`Device ${info.friendly_name} created from devices.js`)
    }

    if (deviceDefinition) {
      const device = new MqttDevice(this, info.friendly_name, info.model_id, deviceDefinition);
      this.client.subscribe(`${this.config.prefix}/${info.friendly_name}`);
      this.handleDeviceAdded(device);
    }
  }

  startPairing(_timeoutSeconds) {
    this.client.publish(`${this.config.prefix}/bridge/config/devices/get`);
    // TODO: Set permitJoin
  }

  cancelPairing() {
    // TODO: Clear permitJoin
  }
}

function loadAdapter(addonManager, manifest, _errorCallback) {
  new ZigbeeMqttAdapter(addonManager, manifest);
}

module.exports = loadAdapter;

