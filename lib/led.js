'use strict';

const fs            = require('fs');
const { execSync }  = require('child_process');
const log           = require('./logger');

/**
 * 前面板指示灯控制
 *
 * WiFi 灯  (b5): 1 = 亮, 0 = 灭（正逻辑）
 *   - WiFi 已连接且互联网畅通 → 常亮
 *   - WiFi 连接中（正在尝试）  → 闪烁
 *   - WiFi 未连接 / 无互联网  → 熄灭
 *
 * BT 灯   (b6): 1 = 亮, 0 = 灭（正逻辑）
 *   - BLE 配网进行中 → 闪烁
 *   - BLE 配网成功   → 常亮
 *   - 蓝牙不工作     → 熄灭
 *
 * SETUP 灯 (b2): 0 = 亮, 1 = 灭（反逻辑，与 APPS 互斥）
 * APPS  灯 (b1): 0 = 亮, 1 = 灭（反逻辑，与 SETUP 互斥）
 *   - claw 未激活 → SETUP 亮，APPS 灭
 *   - claw 已激活 → APPS 亮，SETUP 灭
 */

const LED_PATH          = process.env.CLAWD_LED_PATH    || '/sys/devices/platform/openvfd/attr/b5';
const BT_LED_PATH       = process.env.CLAWD_BT_LED_PATH || '/sys/devices/platform/openvfd/attr/b6';
const SETUP_LED_PATH    = '/sys/devices/platform/openvfd/attr/b1'; // 物理 SETUP 灯
const APPS_LED_PATH     = '/sys/devices/platform/openvfd/attr/b2'; // 物理 APPS 灯
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
    log.info('led', 'WiFi 指示灯 → 常亮');
  }

  /** 熄灭 */
  off() {
    if (this._current === 'off') return;
    this._stopBlink();
    this._write(0);
    this._current = 'off';
    log.info('led', 'WiFi 指示灯 → 熄灭');
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
    log.info('led', 'WiFi 指示灯 → 闪烁');
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
    } catch (e) {
      log.warn('led', `写入失败 (${LED_PATH}): ${e.message}`);
    }
  }
}

// ── 蓝牙指示灯 ───────────────────────────────────────────────────────────────

/**
 * BT 指示灯（b6）正逻辑：1 = 亮，0 = 灭。
 *   blink() — BLE 配网进行中
 *   on()    — BLE 配网成功 / 蓝牙功能正常
 *   off()   — 蓝牙不工作
 */
class BtLed {
  constructor() {
    this._blinkTimer = null;
    this._blinkState = false;
    this._current    = null; // 'on' | 'off' | 'blink'
  }

  /** 常亮（配网成功） */
  on() {
    if (this._current === 'on') return;
    this._stopBlink();
    this._write(1);
    this._current = 'on';
    log.info('led', 'BT 指示灯 → 常亮');
  }

  /** 熄灭（蓝牙不工作） */
  off() {
    if (this._current === 'off') return;
    this._stopBlink();
    this._write(0);
    this._current = 'off';
    log.info('led', 'BT 指示灯 → 熄灭');
  }

  /** 闪烁（BLE 配网进行中） */
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

  /** 释放资源，关灯 */
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
    try {
      fs.writeFileSync(BT_LED_PATH, String(val));
    } catch (e) {
      log.warn('led', `写入失败 (${BT_LED_PATH}): ${e.message}`);
    }
  }
}

// ── VFD 显示屏 ────────────────────────────────────────────────────────────────

const DISPLAY_PATH = '/sys/devices/platform/openvfd/attr/led';

/**
 * VFD 显示屏控制。
 *   #m3 <text>  手动模式，显示指定文字
 *   #s1         系统时钟模式，显示当前时间
 */
class Display {
  constructor() {
    this._blinkTimer = null;
  }

  /** 网络断开 / AP 模式 → 显示 "AP  " */
  showAP() {
    this._stopBlink();
    this._write('#m3AP  ');
    log.info('display', '显示屏 → AP');
  }

  /** WS 连接中（失败次数 < 3）→ 显示 "Conn" 闪烁 */
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

  /** 网络正常但 VPS 不可达 → 显示 "Err0" */
  showErr0() {
    this._stopBlink();
    this._write('#m3Err0');
    log.info('display', '显示屏 → Err0');
  }

  /** 网络已连接 → 显示时间 */
  showTime() {
    this._stopBlink();
    this._write('#s1');
    log.info('display', '显示屏 → 时间');
  }

  /** 未激活 + 连网 → 显示 PIN 码（4 位数字）并闪烁 */
  showPin(pin) {
    this._stopBlink();
    const s = String(pin || '').padStart(4, '0').slice(-4);
    this._write('#m2' + s);
    log.info('display', `显示屏 → PIN: ${s}（闪烁）`);
    // 亮 1s → 灭 0.5s → 循环
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
    try {
      execSync(`echo "${val}" | tee ${DISPLAY_PATH} > /dev/null`, { timeout: 3000 });
    } catch (e) {
      log.warn('display', `写入失败: ${e.message}`);
    }
  }
}

// ── SETUP / APPS 状态灯 ───────────────────────────────────────────────────────

/**
 * SETUP 灯（b2）与 APPS 灯（b1）互斥控制。
 * 两灯均为反逻辑：写 0 = 亮，写 1 = 灭。
 */
class StatusLed {
  /** claw 未激活 → SETUP 亮，APPS 灭 */
  setSetup() {
    this._write(SETUP_LED_PATH, 0); // SETUP 亮
    this._write(APPS_LED_PATH,  1); // APPS  灭
    log.info('led', '状态灯 → SETUP（未激活）');
  }

  /** claw 已激活 → APPS 亮，SETUP 灭 */
  setApps() {
    this._write(SETUP_LED_PATH, 1); // SETUP 灭
    this._write(APPS_LED_PATH,  0); // APPS  亮
    log.info('led', '状态灯 → APPS（已激活）');
  }

  /** 两灯全灭（进程退出时调用） */
  off() {
    this._write(SETUP_LED_PATH, 1);
    this._write(APPS_LED_PATH,  1);
  }

  _write(path, val) {
    try {
      fs.writeFileSync(path, String(val));
    } catch (e) {
      log.warn('led', `写入失败 (${path}): ${e.message}`);
    }
  }
}

// 全局单例，整个进程共用
module.exports         = new WifiLed();
module.exports.bt      = new BtLed();
module.exports.status  = new StatusLed();
module.exports.display = new Display();
