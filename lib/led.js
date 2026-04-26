'use strict';

const log = require('./logger');
const { isRK3566, readDeviceModel } = require('./led/detect');

function loadImpl() {
  const forced = String(process.env.CLAWD_LED_IMPL || '').trim().toLowerCase();
  const model = readDeviceModel();

  let name;
  if (forced) {
    name = forced;
  } else if (isRK3566()) {
    name = 'rk3566';
  } else {
    name = 'openvfd';
  }

  try {
    if (name === 'rk3566' || name === '3566') {
      log.info('led', `LED/VFD backend → rk3566-openvfd (${model || 'unknown model'})`);
      return require('./led/rk3566-openvfd');
    }
    if (name === 'noop' || name === 'none' || name === 'off') {
      log.info('led', `LED/VFD backend → noop (${model || 'unknown model'})`);
      return require('./led/noop');
    }
    if (name !== 'openvfd' && name !== 'default') {
      log.warn('led', `未知 CLAWD_LED_IMPL=${name}，回退 openvfd`);
    }
    log.info('led', `LED/VFD backend → openvfd-class (${model || 'unknown model'})`);
    return require('./led/openvfd-class');
  } catch (e) {
    log.warn('led', `LED/VFD backend ${name} 加载失败：${e.message}，回退 noop`);
    return require('./led/noop');
  }
}

module.exports = loadImpl();
