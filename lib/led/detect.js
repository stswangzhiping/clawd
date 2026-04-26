'use strict';

const fs = require('fs');

function readDeviceModel() {
  try {
    return fs.readFileSync('/proc/device-tree/model', 'utf8')
      .replace(/\0/g, '')
      .trim();
  } catch (_) {
    return '';
  }
}

function isRK3566() {
  return /RK3566/i.test(readDeviceModel());
}

module.exports = {
  readDeviceModel,
  isRK3566,
};
