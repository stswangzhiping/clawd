'use strict';

const { execSync } = require('child_process');
const fs  = require('fs');
const os  = require('os');
const log = require('./logger');

const AP_SSID_PREFIX = 'ClawBox-';
const AP_IP          = '10.42.0.1';
const AP_PASSWORD    = '12345678';
const AP_IFACE       = process.env.CLAWD_WIFI_IFACE || '';
const CON_NAME       = 'clawd-hotspot';

/** 非 WiFi、非典型虚拟接口，用于自动发现有线口（如 end0、enp*，而非仅 eth0） */
function _isExcludedVirtualIface(name) {
  if (name === 'lo' || name === 'bonding_masters') return true;
  if (name.startsWith('wl')) return true;
  if (name.startsWith('docker')) return true;
  if (name.startsWith('veth')) return true;
  if (name.startsWith('virbr')) return true;
  if (name.startsWith('br-')) return true;
  if (name.startsWith('tun') || name.startsWith('tap')) return true;
  if (name.startsWith('wg') || name.startsWith('bond')) return true;
  if (name.startsWith('can')) return true;
  return false;
}

/**
 * 返回当前链路 up 的有线网卡名。
 * 若设置 CLAWD_ETH_IFACE，只认该接口；否则扫描 sysfs（与仅默认 eth0 相比适配更多板型）。
 */
function getWiredIfaceWithCarrier() {
  const explicit = process.env.CLAWD_ETH_IFACE;
  if (explicit) {
    try {
      if (fs.readFileSync(`/sys/class/net/${explicit}/carrier`, 'utf8').trim() === '1') {
        return explicit;
      }
    } catch (_) {}
    return null;
  }

  try {
    const names = fs.readdirSync('/sys/class/net');
    for (const name of names.sort()) {
      if (_isExcludedVirtualIface(name)) continue;
      try {
        if (fs.readFileSync(`/sys/class/net/${name}/carrier`, 'utf8').trim() === '1') {
          return name;
        }
      } catch (_) {}
    }
  } catch (_) {}

  return null;
}

/**
 * 是否存在任一带 carrier 的有线接口（无延迟）
 */
function hasWiredCarrier() {
  return getWiredIfaceWithCarrier() !== null;
}

/**
 * LAN 面板灯专用：若设置 CLAWD_ETH_IFACE，只认该口 carrier（拔网线必灭）；
 * 未设置时退回 hasWiredCarrier()（可能受其它网口影响，建议在 box 上配置 end0 等）。
 */
function hasLanCableCarrier() {
  const explicit = process.env.CLAWD_ETH_IFACE;
  if (explicit) {
    try {
      return fs.readFileSync(`/sys/class/net/${explicit}/carrier`, 'utf8').trim() === '1';
    } catch (_) {
      return false;
    }
  }
  return hasWiredCarrier();
}

function _tryPingInternet() {
  try {
    run('ping -c 1 -W 3 8.8.8.8');
    return true;
  } catch (_) {}

  // 开热点时默认路由可能走 wlan，无 -I 的 ping 会误判；指定有线口再试
  const wired = getWiredIfaceWithCarrier();
  if (wired) {
    try {
      run(`ping -c 1 -W 3 -I ${wired} 8.8.8.8`);
      return true;
    } catch (_) {}
  }
  return false;
}

/**
 * 仅经有线口 ping 公网（不依赖默认路由）。
 * AP 开启时 hasInternet() 易误判；维持 WS / 网络监视时用此兜底。
 */
function hasWiredInternetProbe() {
  const wired = getWiredIfaceWithCarrier();
  if (!wired) return false;
  try {
    run(`ping -c 1 -W 3 -I ${wired} 8.8.8.8`);
    return true;
  } catch (_) {}
  return false;
}

/**
 * 检测是否有互联网连接（nmcli 连通性 + ping 兜底）
 */
function hasInternet() {
  // 物理层快检：无 WiFi STA 且无任何有线 carrier → 立即 false（nmcli 有缓存，不可信）
  if (!isWifiStaConnected() && !hasWiredCarrier()) return false;

  try {
    const out = run('nmcli networking connectivity check').trim();
    if (out === 'full' || out === 'limited') return true;
  } catch (_) {}

  return _tryPingInternet();
}

/**
 * 获取默认 WiFi 接口名（wlan0 等）
 */
function getWifiIface() {
  if (AP_IFACE) return AP_IFACE;
  try {
    const out = run('nmcli -t -f DEVICE,TYPE device | grep wifi | head -1');
    const iface = out.split(':')[0].trim();
    if (iface) return iface;
  } catch (_) {}

  // 兜底
  try {
    const out = run("ls /sys/class/net | grep -E '^wl'");
    const iface = out.split('\n')[0].trim();
    if (iface) return iface;
  } catch (_) {}

  return 'wlan0';
}

/**
 * 扫描周围 WiFi，返回 [{ ssid, signal, security }]
 */
function scanWifi() {
  const iface = getWifiIface();
  try {
    // 先触发一次扫描
    try { run(`nmcli device wifi rescan ifname ${iface}`); } catch (_) {}
    // 等扫描完成
    sleep(2000);

    const out = run('nmcli -t -f SSID,SIGNAL,SECURITY device wifi list');
    const seen = new Set();
    const results = [];
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split(':');
      const ssid = parts[0].trim().replace(/\\:/g, ':');
      if (!ssid || seen.has(ssid)) continue;
      seen.add(ssid);
      results.push({
        ssid,
        signal:   parseInt(parts[1], 10) || 0,
        security: parts.slice(2).join(':').trim() || 'Open',
      });
    }
    results.sort((a, b) => b.signal - a.signal);
    return results;
  } catch (e) {
    log.error('network', 'WiFi 扫描失败:', e.message);
    return [];
  }
}

/**
 * 连接指定 WiFi
 * @returns {{ success: boolean, error?: string }}
 */
function connectWifi(ssid, password) {
  const iface = getWifiIface();
  log.info('network', `尝试连接 WiFi: ${ssid}`);
  try {
    // 先删除可能残留的同名连接
    try { run(`nmcli connection delete "${ssid}"`); } catch (_) {}

    const pwdArg = password ? `password "${password}"` : '';
    run(`nmcli device wifi connect "${ssid}" ${pwdArg} ifname ${iface}`, 30000);

    // 验证连通性
    sleep(3000);
    if (hasInternet()) {
      log.info('network', `WiFi 已连接: ${ssid}`);
      return { success: true };
    }
    return { success: false, error: '已连接但无法访问互联网' };
  } catch (e) {
    log.error('network', `WiFi 连接失败: ${e.message}`);
    return { success: false, error: e.message };
  }
}

/**
 * 启动 WiFi AP 热点
 */
function startAP(clawId) {
  const iface = getWifiIface();
  const ssid  = `${AP_SSID_PREFIX}${clawId || 'Setup'}`;

  log.info('network', `启动 AP 热点: ${ssid} (${iface})`);

  // 关闭已有热点
  stopAP();

  try {
    // nmcli 创建热点（开放网络）
    const cmd = [
      'nmcli device wifi hotspot',
      `ifname ${iface}`,
      `con-name ${CON_NAME}`,
      `ssid "${ssid}"`,
      'band bg',
    ];
    // 如果需要密码
    if (AP_PASSWORD) {
      cmd.push(`password "${AP_PASSWORD}"`);
    }
    run(cmd.join(' '));

    // 等待 AP 启动
    sleep(2000);
    log.info('network', `AP 已启动: ${ssid}, 网关 ${AP_IP}`);
    return { ssid, ip: AP_IP, iface };
  } catch (e) {
    log.error('network', `AP 启动失败: ${e.message}`);
    throw e;
  }
}

/**
 * 关闭热点，恢复普通 WiFi 模式
 */
function stopAP() {
  try {
    run(`nmcli connection down ${CON_NAME}`);
  } catch (_) {}
  try {
    run(`nmcli connection delete ${CON_NAME}`);
  } catch (_) {}
}

// ── 工具 ─────────────────────────────────────────────────────────────────────

function run(cmd, timeout = 10000) {
  return execSync(cmd, {
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function sleep(ms) {
  execSync(`sleep ${ms / 1000}`, { timeout: ms + 2000 });
}

/**
 * 检测是否有已保存的 WiFi STA 连接（排除自身热点）
 */
function hasSavedWifiConnection() {
  try {
    const out = run('nmcli -t -f NAME,TYPE connection show');
    for (const line of out.split('\n')) {
      const [name, type] = line.split(':');
      if (type === '802-11-wireless' && name !== CON_NAME) {
        return true;
      }
    }
  } catch (_) {}
  return false;
}

/**
 * 检测 wlan0 是否以 STA 模式连接了 WiFi（排除自身热点）
 */
function isWifiStaConnected() {
  const iface = getWifiIface();
  try {
    const out = run('nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device');
    for (const line of out.split('\n')) {
      const parts = line.split(':');
      if (parts[0] === iface && parts[1] === 'wifi' && parts[2] === 'connected') {
        return parts[3] !== CON_NAME;
      }
    }
  } catch (_) {}
  return false;
}

/**
 * 获取本机所有非回环 IPv4 地址，逗号拼接返回
 * 例：'192.168.1.100' 或 '192.168.1.100,10.0.0.5'
 */
function getLocalIps() {
  try {
    const ifaces = os.networkInterfaces();
    const ips = [];
    for (const [name, addrs] of Object.entries(ifaces)) {
      if (!addrs) continue;
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal && !addr.address.startsWith('10.42.')) {
          ips.push(addr.address);
        }
      }
    }
    return ips.length > 0 ? ips.join(',') : null;
  } catch (e) {
    log.warn('network', '获取本机 IP 失败:', e.message);
    return null;
  }
}

module.exports = {
  hasInternet,
  hasWiredCarrier,
  hasLanCableCarrier,
  hasWiredInternetProbe,
  getWiredIfaceWithCarrier,
  hasSavedWifiConnection,
  isWifiStaConnected,
  getWifiIface,
  scanWifi,
  connectWifi,
  startAP,
  stopAP,
  AP_IP,
  getLocalIps,
};
