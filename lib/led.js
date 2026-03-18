'use strict';

const fs  = require('fs');
const log = require('./logger');

/**
 * WiFi 指示灯控制
 *
 * 硬件路径: /sys/devices/platform/openvfd/attr/b5
 *   1 = 亮  0 = 灭
 *
 * LED 状态与 WiFi 状态的对应关系：
 *   - WiFi 已连接且互联网畅通 → 常亮
 *   - WiFi 连接中（正在尝试）  → 闪烁
 *   - WiFi 未连接 / 无互联网  → 熄灭
 */

const LED_PATH         = process.env.CLAWD_LED_PATH || '/sys/devices/platform/openvfd/attr/b5';
const BLINK_INTERVAL_MS = 500; // 闪烁间隔（ms）

class WifiLed {
  constructor() {
    this._blinkTimer = null;
    this._blinkState = false;
    this._current    = null; // 'on' | 'off' | 'blink'
  }

  /** 常亮 */
  on() {
    if (this._current === 'on') return;
    this._stopBlink();
    this._write(1);
    this._current = 'on';
    log.debug('led', 'WiFi 指示灯 → 常亮');
  }

  /** 熄灭 */
  off() {
    if (this._current === 'off') return;
    this._stopBlink();
    this._write(0);
    this._current = 'off';
    log.debug('led', 'WiFi 指示灯 → 熄灭');
  }

  /** 闪烁（连接中） */
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
    log.debug('led', 'WiFi 指示灯 → 闪烁');
  }

  /** 释放资源，关灯 */
  destroy() {
    this._stopBlink();
    this._write(0);
    this._current = 'off';
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  _stopBlink() {
    if (this._blinkTimer) {
      clearInterval(this._blinkTimer);
      this._blinkTimer = null;
    }
  }

  _write(val) {
    try {
      fs.writeFileSync(LED_PATH, String(val));
    } catch (_) {
      // 设备不支持 openvfd 时静默忽略（开发机上不会报错）
    }
  }
}

// 全局单例，整个进程共用
module.exports = new WifiLed();
