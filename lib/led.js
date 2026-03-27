'use strict';

const log = require('./logger');

/**
 * 前面板指示灯 / VFD 逻辑（原 openvfd sysfs）。
 * 硬件路径因板型而异，当前不直接写 sysfs：仅在 debug 记录拟写入内容，业务状态仍以 info 输出。
 *
 * WiFi 灯 (b5): 1 = 亮, 0 = 灭（正逻辑）
 * BT 灯   (b6): 1 = 亮, 0 = 灭（正逻辑）
 * SETUP/APPS (b1/b2): 反逻辑，与 claw 激活状态互斥
 *
 * 恢复真机显示时：可在此类 _write 中接新驱动或 CLAWD_* 路径。
 */

const BLINK_INTERVAL_MS = 500;

class WifiLed {
  constructor() {
    this._blinkTimer = null;
    this._blinkState = false;
    this._current    = null;
  }

  on() {
    if (this._current === 'on') return;
    this._stopBlink();
    this._write(1);
    this._current = 'on';
    log.info('led', 'WiFi 指示灯 → 常亮');
  }

  off() {
    if (this._current === 'off') return;
    this._stopBlink();
    this._write(0);
    this._current = 'off';
    log.info('led', 'WiFi 指示灯 → 熄灭');
  }

  blink(intervalMs = BLINK_INTERVAL_MS) {
    if (this._current === 'blink') return;
    this._stopBlink();
    this._blinkState = true;
    this._write(1);
    this._blinkTimer = setInterval(() => {
      this._blinkState = !this._blinkState;
      this._write(this._blinkState ? 1 : 0);
    }, intervalMs);
    this._current = 'blink';
    log.info('led', 'WiFi 指示灯 → 闪烁');
  }

  destroy() {
    this._stopBlink();
    this._write(0);
    this._current = 'off';
  }

  _stopBlink() {
    if (this._blinkTimer) {
      clearInterval(this._blinkTimer);
      this._blinkTimer = null;
    }
  }

  _write(val) {
    log.debug('led', `[vfd] WiFi LED (b5) <= ${val}`);
  }
}

class BtLed {
  constructor() {
    this._blinkTimer = null;
    this._blinkState = false;
    this._current    = null;
  }

  on() {
    if (this._current === 'on') return;
    this._stopBlink();
    this._write(1);
    this._current = 'on';
    log.info('led', 'BT 指示灯 → 常亮');
  }

  off() {
    if (this._current === 'off') return;
    this._stopBlink();
    this._write(0);
    this._current = 'off';
    log.info('led', 'BT 指示灯 → 熄灭');
  }

  blink(intervalMs = BLINK_INTERVAL_MS) {
    if (this._current === 'blink') return;
    this._stopBlink();
    this._blinkState = true;
    this._write(1);
    this._blinkTimer = setInterval(() => {
      this._blinkState = !this._blinkState;
      this._write(this._blinkState ? 1 : 0);
    }, intervalMs);
    this._current = 'blink';
    log.info('led', 'BT 指示灯 → 闪烁');
  }

  destroy() {
    this._stopBlink();
    this._write(0);
    this._current = 'off';
  }

  _stopBlink() {
    if (this._blinkTimer) {
      clearInterval(this._blinkTimer);
      this._blinkTimer = null;
    }
  }

  _write(val) {
    log.debug('led', `[vfd] BT LED (b6) <= ${val}`);
  }
}

class Display {
  constructor() {
    this._blinkTimer = null;
  }

  showAP() {
    this._stopBlink();
    this._write('#m3AP  ');
    log.info('display', '显示屏 → AP');
  }

  showConn() {
    this._stopBlink();
    this._write('#m3Conn');
    log.info('display', '显示屏 → Conn（闪烁）');
    let visible = true;
    const blink = () => {
      visible = !visible;
      this._write(visible ? '#m3Conn' : '#c1');
      this._blinkTimer = setTimeout(blink, visible ? 1000 : 500);
    };
    this._blinkTimer = setTimeout(blink, 1000);
  }

  showErr0() {
    this._stopBlink();
    this._write('#m3Err0');
    log.info('display', '显示屏 → Err0');
  }

  showTime() {
    this._stopBlink();
    this._write('#s1');
    log.info('display', '显示屏 → 时间');
  }

  showPin(pin) {
    this._stopBlink();
    const s = String(pin || '').padStart(4, '0').slice(-4);
    this._write('#m2' + s);
    log.info('display', `显示屏 → PIN: ${s}（闪烁）`);
    let visible = true;
    const blink = () => {
      visible = !visible;
      this._write(visible ? '#m2' + s : '#c1');
      this._blinkTimer = setTimeout(blink, visible ? 1000 : 500);
    };
    this._blinkTimer = setTimeout(blink, 1000);
  }

  _stopBlink() {
    if (this._blinkTimer) {
      clearTimeout(this._blinkTimer);
      clearInterval(this._blinkTimer);
      this._blinkTimer = null;
    }
  }

  _write(val) {
    log.debug('display', `[vfd] ${val}`);
  }
}

class StatusLed {
  setSetup() {
    this._write('SETUP', 0);
    this._write('APPS', 1);
    log.info('led', '状态灯 → SETUP（未激活）');
  }

  setApps() {
    this._write('SETUP', 1);
    this._write('APPS', 0);
    log.info('led', '状态灯 → APPS（已激活）');
  }

  off() {
    this._write('SETUP', 1);
    this._write('APPS', 1);
  }

  _write(which, val) {
    log.debug('led', `[vfd] 状态灯 ${which} (b1/b2 反逻辑) <= ${val}`);
  }
}

module.exports         = new WifiLed();
module.exports.bt      = new BtLed();
module.exports.status  = new StatusLed();
module.exports.display = new Display();
