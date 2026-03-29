'use strict';

const fs  = require('fs');
const log = require('./logger');
const { hasLanCableCarrier } = require('./network');

/**
 * OpenVFD 图标：/sys/class/leds/openvfd/led_on|led_off（写入图标名）。
 *
 * 映射（与面板丝印一致：LAN=play，WiFi=wifi+eth）：
 *   wifi + eth 同亮/同灭 → 产品 WiFi 灯（配网 on/off/blink）
 *   play → LAN（有线插拔，见 hasLanCableCarrier / CLAWD_ETH_IFACE）
 *   alarm → pwr（SETUP=灭 / APPS=亮）
 *   BT    → 无 sysfs，仅日志
 *
 * 数码管：vfdservice 管道（660 字节，mode=4 TITLE / mode=1 CLOCK，与板端 Demo 一致）。
 * CLAWD_VFD_PIPE 默认 /tmp/openvfd_service；管道不存在时仅 debug，不抛错。
 *
 * CLAWD_OPENVFD_PATH 默认 /sys/class/leds/openvfd（图标灯）
 */

const BLINK_INTERVAL_MS = 500;
const LAN_POLL_MS       = 500;

const VFD_BASE = process.env.CLAWD_OPENVFD_PATH || '/sys/class/leds/openvfd';
const VFD_PIPE = process.env.CLAWD_VFD_PIPE || '/tmp/openvfd_service';
const VFD_BUF_SIZE   = 660;
const VFD_MODE_CLOCK = 1;
const VFD_MODE_TITLE = 4;
const VFD_TITLE_OFF  = 20;

function vfdPipePresent() {
  try {
    return fs.existsSync(VFD_PIPE);
  } catch (_) {
    return false;
  }
}

/** TITLE：固定 4 字符，ASCII，供 vfdservice 解析为段码 */
function vfdTitleNormalize(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9 \-]/g, ' ')
    .slice(0, 4)
    .padEnd(4, ' ');
}

function writeVfdPipeTitle(text4) {
  if (!vfdPipePresent()) return;
  const seg = vfdTitleNormalize(text4);
  const data = Buffer.alloc(VFD_BUF_SIZE);
  data.writeUInt16LE(VFD_MODE_TITLE, 0);
  try {
    data.write(`${seg}\0`, VFD_TITLE_OFF, 'ascii');
  } catch (e) {
    log.debug('display', `openvfd title encode: ${e.message}`);
    return;
  }
  try {
    const fd = fs.openSync(VFD_PIPE, 'w');
    fs.writeSync(fd, data);
    fs.closeSync(fd);
  } catch (e) {
    log.debug('display', `openvfd pipe title: ${e.message}`);
  }
}

function writeVfdPipeClock() {
  if (!vfdPipePresent()) return;
  const data = Buffer.alloc(VFD_BUF_SIZE);
  data.writeUInt16LE(VFD_MODE_CLOCK, 0);
  try {
    const fd = fs.openSync(VFD_PIPE, 'w');
    fs.writeSync(fd, data);
    fs.closeSync(fd);
  } catch (e) {
    log.debug('display', `openvfd pipe clock: ${e.message}`);
  }
}

function vfdOn(icon) {
  try {
    fs.writeFileSync(`${VFD_BASE}/led_on`, icon);
  } catch (e) {
    log.debug('led', `openvfd led_on ${icon}: ${e.message}`);
  }
}

function vfdOff(icon) {
  try {
    fs.writeFileSync(`${VFD_BASE}/led_off`, icon);
  } catch (e) {
    log.debug('led', `openvfd led_off ${icon}: ${e.message}`);
  }
}

function vfdWifiPair(on) {
  if (on) {
    vfdOn('wifi');
    vfdOn('eth');
  } else {
    vfdOff('wifi');
    vfdOff('eth');
  }
}

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
    const on = !!val;
    log.debug('led', `[vfd] WiFi（wifi+eth）<= ${on ? 1 : 0}`);
    vfdWifiPair(on);
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

  _write(_val) {
    log.debug('led', '[vfd] BT 无 OpenVFD 映射，忽略');
  }
}

class Display {
  constructor() {
    this._blinkTimer = null;
  }

  showAP() {
    this._stopBlink();
    this._pipeTitle('AP  ', '#m3AP  ');
    log.info('display', '显示屏 → AP（闪烁）');
    let visible = true;
    const blink = () => {
      visible = !visible;
      this._pipeTitle(visible ? 'AP  ' : '    ', visible ? '#m3AP  ' : '#c1');
      this._blinkTimer = setTimeout(blink, visible ? 1000 : 500);
    };
    this._blinkTimer = setTimeout(blink, 1000);
  }

  showConn() {
    this._stopBlink();
    this._pipeTitle('Conn', '#m3Conn');
    log.info('display', '显示屏 → Conn（闪烁）');
    let visible = true;
    const blink = () => {
      visible = !visible;
      this._pipeTitle(visible ? 'Conn' : '    ', visible ? '#m3Conn' : '#c1');
      this._blinkTimer = setTimeout(blink, visible ? 1000 : 500);
    };
    this._blinkTimer = setTimeout(blink, 1000);
  }

  showErr0() {
    this._stopBlink();
    this._pipeTitle('Err0', '#m3Err0');
    log.info('display', '显示屏 → Err0');
  }

  showTime() {
    this._stopBlink();
    log.debug('display', '[vfd] #s1');
    writeVfdPipeClock();
    log.info('display', '显示屏 → 时间');
  }

  showPin(pin) {
    this._stopBlink();
    const s = String(pin || '').padStart(4, '0').slice(-4);
    this._pipeTitle(s, '#m2' + s);
    log.info('display', `显示屏 → PIN: ${s}（闪烁）`);
    let visible = true;
    const blink = () => {
      visible = !visible;
      this._pipeTitle(visible ? s : '    ', visible ? '#m2' + s : '#c1');
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

  /** 保留原 #m3/#m2/#c1 的 debug 语义，并写 vfdservice TITLE */
  _pipeTitle(fourCharText, debugLegacy) {
    log.debug('display', `[vfd] ${debugLegacy}`);
    writeVfdPipeTitle(fourCharText);
  }
}

class StatusLed {
  setSetup() {
    vfdOff('alarm');
    log.debug('led', '[vfd] alarm（pwr）<= 0');
    log.info('led', '状态灯 → SETUP（未激活）');
  }

  setApps() {
    vfdOn('alarm');
    // 部分 OpenVFD 驱动单次写入生效慢，短延迟再写一次
    setTimeout(() => vfdOn('alarm'), 50);
    log.debug('led', '[vfd] alarm（pwr）<= 1');
    log.info('led', '状态灯 → APPS（已激活）');
  }

  off() {
    vfdOff('alarm');
    log.debug('led', '[vfd] alarm（pwr）<= 0 (off)');
  }
}

class LanLed {
  constructor() {
    this._timer   = null;
    this._current = null;
  }

  start() {
    this._sync();
    this._timer = setInterval(() => this._sync(), LAN_POLL_MS);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    vfdOff('play');
    this._current = null;
  }

  _sync() {
    const up = hasLanCableCarrier();
    if (up) {
      if (this._current !== 'on') {
        vfdOn('play');
        this._current = 'on';
        log.info('led', 'LAN（play / 有线 carrier）→ 亮');
      }
    } else if (this._current !== 'off') {
      vfdOff('play');
      this._current = 'off';
      log.info('led', 'LAN（play / 有线 carrier）→ 灭');
    }
  }
}

const lan = new LanLed();

module.exports         = new WifiLed();
module.exports.bt      = new BtLed();
module.exports.status  = new StatusLed();
module.exports.display = new Display();
module.exports.lan     = lan;
