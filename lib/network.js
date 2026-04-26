'use strict';

const { execSync, spawnSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const log = require('./logger');

const AP_SSID_PREFIX = 'ClawBox-';
const AP_IP = '10.42.0.1';
const AP_PASSWORD = '12345678';
const AP_IFACE = process.env.CLAWD_WIFI_IFACE || '';
const CON_NAME = 'clawd-hotspot';

/** 产品 RJ45 在 sysfs 中的默认名；等价于检测 `cat /sys/class/net/end0/carrier` */
const DEFAULT_ETH_IFACE = 'end0';

function _ethIfaceEnvOrDefault() {
  return process.env.CLAWD_ETH_IFACE || DEFAULT_ETH_IFACE;
}

function _netIfaceExists(name) {
  try {
    return fs.existsSync(`/sys/class/net/${name}`);
  } catch (_) {
    return false;
  }
}

/** 读取 `/sys/class/net/<iface>/carrier`，`1` 为链路 up；缺失或异常视为 down */
function _sysfsCarrierUp(iface) {
  try {
    return fs.readFileSync(`/sys/class/net/${iface}/carrier`, 'utf8').trim() === '1';
  } catch (_) {
    return false;
  }
}

/** 非 WiFi、非典型虚拟接口，用于开发机扫描有线口（enp* 等） */
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
 * 开发机：无 CLAWD_ETH_IFACE 且无 end0 时，扫描 sysfs 找第一个 carrier=1 的有线口。
 */
function _firstScanWiredIfaceWithCarrier() {
  try {
    const names = fs.readdirSync('/sys/class/net');
    for (const name of names.sort()) {
      if (_isExcludedVirtualIface(name)) continue;
      if (_sysfsCarrierUp(name)) return name;
    }
  } catch (_) {}
  return null;
}

/**
 * 返回当前可用于「有线 ping / 路由」的网卡名。
 * 优先级：CLAWD_ETH_IFACE → 存在 end0 则只用 end0 → 否则扫描 sysfs。
 */
function getWiredIfaceWithCarrier() {
  const explicit = process.env.CLAWD_ETH_IFACE;
  if (explicit) {
    return _netIfaceExists(explicit) && _sysfsCarrierUp(explicit) ? explicit : null;
  }
  if (_netIfaceExists(DEFAULT_ETH_IFACE)) {
    return _sysfsCarrierUp(DEFAULT_ETH_IFACE) ? DEFAULT_ETH_IFACE : null;
  }
  return _firstScanWiredIfaceWithCarrier();
}

function hasWiredCarrier() {
  return getWiredIfaceWithCarrier() !== null;
}

/**
 * LAN 面板灯：只反映 RJ45 对应口，与 `cat /sys/class/net/end0/carrier 2>/dev/null` 同源（仅读 carrier）。
 * 若配置的接口在 sysfs 中不存在（常见为开发机无 end0），则退回与 hasWiredCarrier() 一致，避免灯永远灭。
 */
function hasLanCableCarrier() {
  const iface = _ethIfaceEnvOrDefault();
  if (_netIfaceExists(iface)) return _sysfsCarrierUp(iface);
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
 * 获取默认 WiFi 接口名（wlan0 等）。
 * 必须 TYPE 精确为 wifi，不能用 grep wifi（会误匹配 wifi-p2p，导致选到 p2p-dev-wlan0，STA/热点均失败）。
 */
function getWifiIface() {
  if (AP_IFACE) return AP_IFACE;
  try {
    const out = run('nmcli -t -f DEVICE,TYPE device');
    let fallback = '';
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split(':');
      const dev = (parts[0] || '').trim();
      const type = (parts[1] || '').trim();
      if (type !== 'wifi' || !dev) continue;
      if (dev.startsWith('p2p-dev-')) continue;
      if (dev.startsWith('wlan')) return dev;
      if (!fallback) fallback = dev;
    }
    if (fallback) return fallback;
  } catch (_) {}

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

    // 指定 ifname，避免 AP/多网卡场景下读取到非目标接口或旧缓存；带回频率便于诊断 2.4G/5G。
    const out = run(`nmcli -t -f SSID,SIGNAL,SECURITY,FREQ device wifi list ifname ${iface}`);
    const seen = new Set();
    const results = [];
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const parts = _parseNmcliTerseLine(line);
      const ssid = (parts[0] || '').trim();
      if (!ssid || seen.has(ssid)) continue;
      seen.add(ssid);
      const freq = (parts[3] || '').trim();
      const freqMhz = parseInt(freq, 10) || null;
      results.push({
        ssid,
        signal:   parseInt(parts[1], 10) || 0,
        security: (parts[2] || '').trim() || 'Open',
        freq,
        band: freqMhz ? (freqMhz >= 4900 ? '5G' : '2.4G') : null,
      });
    }
    results.sort((a, b) => b.signal - a.signal);
    return results;
  } catch (e) {
    log.error('network', 'WiFi 扫描失败:', e.message);
    return [];
  }
}

/** AP 切 STA 后等待网卡进入 connected 的最长时间（不依赖外网探测） */
const CONNECT_WIFI_STA_WAIT_MS = 25_000;
const CONNECT_WIFI_STA_POLL_MS = 1_000;

/** 不走 shell，避免 SSID/密码中的引号、空格、$ 等破坏命令 */
function nmcliSync(args, timeoutMs = 60000) {
  const r = spawnSync('nmcli', args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const msg = (r.stderr || '').trim() || (r.stdout || '').trim() || `nmcli exit ${r.status}`;
    throw new Error(msg);
  }
  return (r.stdout || '').trim();
}

function _delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 异步 nmcli，不阻塞事件循环（systemd Watchdog 依赖 setInterval 在主线程运行） */
function nmcliAsync(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn('nmcli', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('nmcli 超时'));
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const msg = stderr.trim() || stdout.trim() || `nmcli exit ${code}`;
        reject(new Error(msg));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/**
 * 连接指定 WiFi（配网场景：成功 = NM 显示 STA 已连上目标网，不要求一定能 ping 通 8.8.8.8）
 * 必须异步：同步 spawnSync + execSync(sleep) 会卡住主线程，导致 systemd WatchdogSec 内收不到 WATCHDOG=1。
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function connectWifi(ssid, password) {
  const iface = getWifiIface();
  log.info('network', `尝试连接 WiFi: ${ssid}（ifname=${iface}）`);
  try {
    try {
      await nmcliAsync(['connection', 'delete', ssid], 15000);
    } catch (_) {}

    try {
      await nmcliAsync(['device', 'set', iface, 'managed', 'yes'], 8000);
    } catch (_) {}

    const args = ['device', 'wifi', 'connect', ssid];
    if (password) args.push('password', password);
    args.push('ifname', iface);
    await nmcliAsync(args, 120000);
    await _ensureActiveWifiAutoconnect();

    const deadline = Date.now() + CONNECT_WIFI_STA_WAIT_MS;
    while (Date.now() < deadline) {
      if (isWifiStaConnected()) {
        if (hasInternet()) {
          log.info('network', `WiFi 已连接且有外网: ${ssid}`);
        } else {
          log.warn(
            'network',
            `WiFi STA 已连接（${ssid}），暂未检测到外网；配网仍视为成功（内网/防火墙/国内 DNS 常见）`,
          );
        }
        return { success: true };
      }
      await _delay(CONNECT_WIFI_STA_POLL_MS);
    }
    return { success: false, error: '超时：网卡未进入已连接状态' };
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
    try {
      nmcliSync(['connection', 'modify', CON_NAME, 'connection.autoconnect', 'no'], 8000);
    } catch (_) {}

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

function _parseNmcliTerseLine(line) {
  const fields = [];
  let cur = '';
  let escaped = false;
  for (const ch of line) {
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === ':') {
      fields.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  fields.push(cur);
  return fields;
}

/**
 * 列出已保存的 WiFi STA 连接（排除自身热点），按 autoconnect-priority 从高到低排序。
 */
function listSavedWifiConnections() {
  const profiles = [];
  try {
    const out = run('nmcli -t -f NAME,UUID,TYPE,AUTOCONNECT,AUTOCONNECT-PRIORITY connection show');
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const [name, uuid, type, autoconnect, priority] = _parseNmcliTerseLine(line);
      if (type !== '802-11-wireless' || name === CON_NAME) continue;
      profiles.push({
        name,
        uuid,
        autoconnect: autoconnect === 'yes',
        priority: parseInt(priority, 10) || 0,
      });
    }
  } catch (_) {}
  profiles.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    if (a.autoconnect !== b.autoconnect) return a.autoconnect ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return profiles;
}

/**
 * 检测是否有已保存的 WiFi STA 连接（排除自身热点）
 */
function hasSavedWifiConnection() {
  return listSavedWifiConnections().length > 0;
}

function getWifiActiveConnectionName() {
  const iface = getWifiIface();
  try {
    const conn = nmcliSync(['-g', 'GENERAL.CONNECTION', 'device', 'show', iface], 8000).trim();
    return conn && conn !== '--' ? conn : null;
  } catch (_) {
    return null;
  }
}

async function _ensureActiveWifiAutoconnect() {
  const conn = getWifiActiveConnectionName();
  if (!conn || conn === CON_NAME) return;
  try {
    await nmcliAsync(['connection', 'modify', conn, 'connection.autoconnect', 'yes'], 15000);
  } catch (e) {
    log.warn('network', `设置 WiFi 自动连接失败: ${conn}: ${e.message}`);
  }
}

/**
 * 主动让 NetworkManager 尝试已保存 WiFi。
 * clawd 只做调度；真正的认证、DHCP、重连细节仍交给 NM。
 */
async function connectSavedWifiConnections() {
  const iface = getWifiIface();
  const profiles = listSavedWifiConnections();
  if (profiles.length === 0) {
    return { success: false, error: '没有已保存的 WiFi 配置' };
  }

  try {
    await nmcliAsync(['device', 'set', iface, 'managed', 'yes'], 8000);
  } catch (_) {}

  let lastError = '';
  for (const profile of profiles) {
    const label = profile.name || profile.uuid;
    try {
      log.info('network', `尝试连接已保存 WiFi: ${label}（ifname=${iface}）`);
      const idArgs = profile.uuid ? ['uuid', profile.uuid] : ['id', profile.name];
      await nmcliAsync(['connection', 'up', ...idArgs, 'ifname', iface], 90000);
      if (isWifiStaConnected()) {
        await _ensureActiveWifiAutoconnect();
        log.info('network', `已保存 WiFi 连接成功: ${label}`);
        return { success: true, profile };
      }
      lastError = '连接命令完成但网卡未进入 STA connected 状态';
    } catch (e) {
      lastError = e.message;
      log.warn('network', `已保存 WiFi 连接失败: ${label}: ${e.message}`);
    }
  }

  return { success: false, error: lastError || '所有已保存 WiFi 均连接失败' };
}

/**
 * 是否已以 STA 连上某 WiFi（排除自身热点）。
 * 不用 device 列表按 `:` 拆字段（连接名含冒号会错；state 含 connecting 勿误匹配 connected）。
 */
function isWifiStaConnected() {
  const iface = getWifiIface();
  let state;
  let conn;
  try {
    state = nmcliSync(['-g', 'GENERAL.STATE', 'device', 'show', iface], 8000);
    conn = nmcliSync(['-g', 'GENERAL.CONNECTION', 'device', 'show', iface], 8000);
  } catch (_) {
    return false;
  }
  const s = (state || '').trim();
  const c = (conn || '').trim();
  if (!/\(connected\)/.test(s)) return false;
  if (!c || c === CON_NAME) return false;
  return true;
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
  listSavedWifiConnections,
  hasSavedWifiConnection,
  connectSavedWifiConnections,
  isWifiStaConnected,
  getWifiIface,
  scanWifi,
  connectWifi,
  startAP,
  stopAP,
  AP_IP,
  getLocalIps,
};
