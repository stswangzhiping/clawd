'use strict';

const { execSync } = require('child_process');
const fs  = require('fs');
const log = require('./logger');
const led = require('./led');

const POLL_INTERVAL_MS = 3000;

function findBin(name, candidates) {
  for (const p of candidates) {
    try { fs.accessSync(p); return p; } catch (_) {}
  }
  return name; // fallback: rely on PATH
}

/**
 * 监控蓝牙状态，驱动 BT 指示灯（b6）。
 *
 * 状态优先级：
 *   connected  → 常亮   (hcitool con 检测到 ACL 连接)
 *   scanning   → 闪烁   (bluetoothctl show: Discovering: yes)
 *   connecting → 闪烁   (bluetoothctl devices: 有 Connecting 状态)
 *   off        → 熄灭   (adapter 不存在 / Powered: no / 静止)
 */
class BtMonitor {
  constructor() {
    this._timer   = null;
    this._btctl   = findBin('bluetoothctl', [
      '/usr/bin/bluetoothctl', '/bin/bluetoothctl',
    ]);
    this._hcitool = findBin('hcitool', [
      '/usr/bin/hcitool', '/usr/sbin/hcitool', '/bin/hcitool',
    ]);
  }

  start() {
    this._poll();
    this._timer = setInterval(() => this._poll(), POLL_INTERVAL_MS);
    log.info('bt', 'BT 状态监控已启动');
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    led.bt.off();
    log.info('bt', 'BT 状态监控已停止');
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  _poll() {
    try {
      const state = this._getBtState();
      if (state === 'connected') {
        led.bt.on();
      } else if (state === 'scanning' || state === 'connecting') {
        led.bt.blink();
      } else {
        led.bt.off();
      }
    } catch (e) {
      log.warn('bt', `状态检测异常: ${e.message}`);
      led.bt.off();
    }
  }

  _exec(cmd, timeout = 3000) {
    return execSync(cmd, {
      timeout,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
  }

  _getBtState() {
    // 1. 检查 adapter 是否存在且已开启
    let show;
    try {
      show = this._exec(`${this._btctl} show`);
    } catch (_) {
      return 'off'; // bluetoothctl 不可用 或 无 adapter
    }
    if (!show.includes('Powered: yes')) return 'off';

    // 2. 检查是否有已连接的 ACL 设备（A2DP 连接）
    try {
      const con = this._exec(`${this._hcitool} con`);
      if (/ACL\s+[0-9A-Fa-f:]{17}/i.test(con)) return 'connected';
    } catch (_) {}

    // 3. 部分版本支持 bluetoothctl devices Connected
    try {
      const devs = this._exec(`${this._btctl} devices Connected`);
      if (devs.trim()) return 'connected';
    } catch (_) {}

    // 4. 检查是否正在扫描
    if (show.includes('Discovering: yes')) return 'scanning';

    return 'off';
  }
}

module.exports = { BtMonitor };
