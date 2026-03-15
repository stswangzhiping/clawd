'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

/**
 * 生成硬件唯一指纹作为 box_id。
 *
 * 策略：
 *   优先 将 machine-id + CPU serial + 磁盘 serial 拼接后取 SHA-256 前 32 字符，
 *   三者至少能拿到一个即可用此方案，防止 ghost clone 场景下 machine-id 相同的问题。
 *
 *   若均拿不到则依次退化：
 *     DMI UUID → 持久化随机 UUID
 *
 * 注意：MAC 地址故意排除，网卡更换/虚拟化/Docker 都会导致其变化。
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

// ── 3. 主存储设备序列号 ────────────────────────────────────────────────────────
function getDiskSerial() {
  // 按优先级依次尝试常见块设备
  const candidates = [
    '/sys/block/sda/device/serial',
    '/sys/block/sdb/device/serial',
    '/sys/block/nvme0n1/device/serial',
    '/sys/block/mmcblk0/device/serial',   // SD 卡（RPi）
    '/sys/block/vda/device/serial',       // 虚拟磁盘
  ];

  for (const p of candidates) {
    try {
      const serial = fs.readFileSync(p, 'utf8').trim().replace(/\s+/g, '');
      if (serial && serial.length >= 4 && serial !== '0000000000000000') {
        return crypto.createHash('sha256').update('disk:' + serial).digest('hex').slice(0, 32);
      }
    } catch (_) {}
  }

  // 兜底：尝试 lsblk（需要 util-linux，大多数发行版自带）
  try {
    const out = execSync(
      "lsblk --nodeps -o SERIAL --noheadings 2>/dev/null | head -1",
      { timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }
    ).toString().trim();
    if (out && out.length >= 4) {
      return crypto.createHash('sha256').update('disk:' + out).digest('hex').slice(0, 32);
    }
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
  const machineId  = getMachineId();
  const cpuSerial  = getCpuSerial();
  const diskSerial = getDiskSerial();

  // 只要能拿到其中任意一项，就把三者拼接后取哈希，避免 ghost clone 场景
  if (machineId || cpuSerial || diskSerial) {
    const raw = [machineId || '', cpuSerial || '', diskSerial || ''].join(':');
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
  }

  return getDmiUuid() || getPersistentUUID();
}

module.exports = { getBoxId };
