'use strict';

const { execSync } = require('child_process');
const fs  = require('fs');
const log = require('./logger');

const AP_SSID_PREFIX = 'ClawBox-';
const AP_IP          = '10.42.0.1';
const AP_PASSWORD    = '12345678';
const AP_IFACE       = process.env.CLAWD_WIFI_IFACE || '';
const ETH_IFACE      = process.env.CLAWD_ETH_IFACE  || 'eth0';
const CON_NAME       = 'clawd-hotspot';

/**
 * 检查有线网卡物理链路是否接通（读 sysfs carrier，无延迟）
 */
function hasWiredCarrier() {
  try {
    const carrier = fs.readFileSync(`/sys/class/net/${ETH_IFACE}/carrier`, 'utf8').trim();
    return carrier === '1';
  } catch (_) {
    return false;
  }
}

/**
 * 检测是否有互联网连接（尝试 DNS 解析 + HTTP 连通性）
 */
function hasInternet() {
  // 物理层快检：无 WiFi STA 且有线 carrier=0 → 立即返回 false（nmcli 有缓存，不可信）
  if (!isWifiStaConnected() && !hasWiredCarrier()) return false;

  // 优先用 nmcli 的 connectivity check
  try {
    const out = run('nmcli networking connectivity check').trim();
    if (out === 'full' || out === 'limited') return true;
  } catch (_) {}

  // 兜底：ping DNS
  try {
    run('ping -c 1 -W 3 8.8.8.8');
    return true;
  } catch (_) {}

  return false;
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

module.exports = {
  hasInternet,
  hasWiredCarrier,
  hasSavedWifiConnection,
  isWifiStaConnected,
  getWifiIface,
  scanWifi,
  connectWifi,
  startAP,
  stopAP,
  AP_IP,
};
