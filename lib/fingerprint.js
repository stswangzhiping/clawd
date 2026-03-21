'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

/**
 * 生成硬件唯一指纹作为 box_id。
 *
 * 策略：
 *   将 machine-id + CPU serial + 有线网卡永久 MAC 拼接后取 SHA-256 前 32 字符。
 *   三者至少能拿到一个即可用此方案，防止 ghost clone 场景下 machine-id 相同的问题。
 *
 *   若均拿不到则依次退化：
 *     DMI UUID → 持久化随机 UUID
 *
 * 注意：磁盘序列号排除（lsblk 兜底不稳定，不同内核版本/驱动可能返回空值）。
 * 有线 MAC 适用于嵌入式设备（网卡焊在主板，由固件烧录，不会更换）。
 */

const PERSIST_FILE = '/etc/clawd/.box_id';

// ── 1. /etc/machine-id ───────────────────────────────────────────────────────
function getMachineId() {
  try {
    const id = fs.readFileSync('/etc/machine-id', 'utf8').trim();
    if (id && /^[0-9a-f]{32}$/i.test(id)) return id;
  } catch (_) {}
  return null;
}

// ── 2. CPU Serial（ARM / Raspberry Pi）───────────────────────────────────────
function getCpuSerial() {
  try {
    const info = fs.readFileSync('/proc/cpuinfo', 'utf8');
    const match = info.match(/^Serial\s*:\s*([0-9a-fA-F]{8,})$/m);
    if (match) {
      const serial = match[1].replace(/^0+/, '');   // 去掉前导零
      if (serial.length >= 8) return serial.padStart(16, '0');
    }
  } catch (_) {}
  return null;
}

// ── 3. 有线网卡永久 MAC 地址 ──────────────────────────────────────────────────
// 嵌入式设备网卡焊在主板，MAC 由固件烧录，比磁盘序列号更稳定。
// 优先读 ethtool 永久 MAC，其次读 sysfs 且类型为 PERM(0) 的地址。
function getEthMac() {
  const iface = process.env.CLAWD_ETH_IFACE || 'eth0';

  // 1. ethtool 永久 MAC（最可信）
  try {
    const out = execSync(`ethtool -P ${iface} 2>/dev/null`, {
      timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    const m = out.match(/Permanent address:\s*([0-9a-f:]{17})/i);
    if (m) {
      const mac = m[1].replace(/:/g, '').toLowerCase();
      if (mac && mac !== '000000000000' && mac !== 'ffffffffffff') return mac;
    }
  } catch (_) {}

  // 2. sysfs：仅在 address_assign_type=0（NET_ADDR_PERM）时使用
  try {
    const assignType = fs.readFileSync(
      `/sys/class/net/${iface}/addr_assign_type`, 'utf8'
    ).trim();
    if (assignType === '0') {
      const mac = fs.readFileSync(`/sys/class/net/${iface}/address`, 'utf8')
        .trim().replace(/:/g, '').toLowerCase();
      if (mac && mac.length === 12 && mac !== '000000000000') return mac;
    }
  } catch (_) {}

  // 3. 兜底：直接读 address（不验证是否随机化，总比无值强）
  try {
    const mac = fs.readFileSync(`/sys/class/net/${iface}/address`, 'utf8')
      .trim().replace(/:/g, '').toLowerCase();
    if (mac && mac.length === 12 && mac !== '000000000000') return mac;
  } catch (_) {}

  return null;
}

// ── 4. DMI 产品 UUID（x86 主板）──────────────────────────────────────────────
function getDmiUuid() {
  try {
    const uuid = fs.readFileSync('/sys/class/dmi/id/product_uuid', 'utf8').trim();
    // 排除全零/全F等无效值
    if (uuid && uuid !== '00000000-0000-0000-0000-000000000000'
             && uuid !== 'ffffffff-ffff-ffff-ffff-ffffffffffff') {
      return uuid.replace(/-/g, '').toLowerCase();
    }
  } catch (_) {}
  return null;
}

// ── 5. 持久化随机 UUID 兜底 ───────────────────────────────────────────────────
function getPersistentUUID() {
  // 先尝试读已有的
  try {
    const id = fs.readFileSync(PERSIST_FILE, 'utf8').trim();
    if (id && id.length >= 16) return id;
  } catch (_) {}

  // 生成新的并写入
  const id = crypto.randomUUID().replace(/-/g, '');
  try {
    fs.mkdirSync(path.dirname(PERSIST_FILE), { recursive: true });
    fs.writeFileSync(PERSIST_FILE, id, 'utf8');
  } catch (e) {
    // 写不进去也没关系，本次用内存值（重启后会变，但这是最后兜底）
    const log = require('./logger');
    log.warn('fingerprint', '无法持久化 box_id:', e.message);
  }
  return id;
}

// ── 主函数 ────────────────────────────────────────────────────────────────────
function getBoxId() {
  const machineId = getMachineId();
  const cpuSerial = getCpuSerial();
  const ethMac    = getEthMac();

  // 只要能拿到其中任意一项，就把三者拼接后取哈希
  if (machineId || cpuSerial || ethMac) {
    const raw = [machineId || '', cpuSerial || '', ethMac || ''].join(':');
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
  }

  return getDmiUuid() || getPersistentUUID();
}

module.exports = { getBoxId };
