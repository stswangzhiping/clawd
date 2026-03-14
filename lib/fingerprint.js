'use strict';

const fs     = require('fs');
const crypto = require('crypto');
const os     = require('os');

/**
 * 生成硬件唯一指纹作为 box_id，优先级：
 *   1. /etc/machine-id   （systemd 生成，现代 Linux 标配）
 *   2. /proc/sys/kernel/random/boot_id  （内核 boot UUID，重启会变但稳定）
 *   3. 第一块网卡 MAC 地址的 SHA-256 前 16 字节
 *   4. 随机 UUID（最后兜底，存入配置防止每次变化）
 */
function getBoxId() {
  // 1. /etc/machine-id
  try {
    const id = fs.readFileSync('/etc/machine-id', 'utf8').trim();
    if (id && id.length >= 16) return id;
  } catch (_) {}

  // 2. boot_id
  try {
    const id = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim().replace(/-/g, '');
    if (id && id.length >= 16) return id;
  } catch (_) {}

  // 3. MAC 地址
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
          return crypto.createHash('sha256').update(iface.mac).digest('hex').slice(0, 32);
        }
      }
    }
  } catch (_) {}

  // 4. 随机 UUID 兜底
  return crypto.randomUUID().replace(/-/g, '');
}

module.exports = { getBoxId };
