'use strict';

const si = require('systeminformation');
const os = require('os');

/**
 * 采集当前系统指标，返回符合 claw 协议的 metrics 对象
 * 所有数值均保留 2 位小数，内存/磁盘单位为 KB
 */
async function collect() {
  const [load, mem, fsArr, temp] = await Promise.allSettled([
    si.currentLoad(),
    si.mem(),
    si.fsSize(),
    si.cpuTemperature(),
  ]);

  const r2 = (v) => (typeof v === 'number' && isFinite(v)) ? Math.round(v * 100) / 100 : null;
  const toKB = (bytes) => (typeof bytes === 'number') ? Math.round(bytes / 1024) : null;

  // CPU
  const cpu = load.status === 'fulfilled'
    ? r2(load.value.currentLoad)
    : null;

  // 内存（bytes → KB）；用 total - available 反映真实占用，与 free -h 一致
  const memVal = mem.status === 'fulfilled' ? mem.value : {};
  const mem_total = toKB(memVal.total);
  const mem_used  = toKB((memVal.total || 0) - (memVal.available || 0));

  // 磁盘：聚合所有真实挂载点，排除虚拟文件系统
  const VIRTUAL_FS = new Set(['tmpfs', 'devtmpfs', 'overlay', 'squashfs', 'ramfs', 'sysfs', 'proc']);
  let disk_total = null, disk_used = null;
  if (fsArr.status === 'fulfilled' && fsArr.value.length > 0) {
    const realFs = fsArr.value.filter(f => f.size > 0 && !VIRTUAL_FS.has(f.type));
    if (realFs.length > 0) {
      disk_total = toKB(realFs.reduce((s, f) => s + f.size, 0));
      disk_used  = toKB(realFs.reduce((s, f) => s + f.used, 0));
    }
  }

  // 温度
  const temperature = temp.status === 'fulfilled'
    ? r2(temp.value.main)
    : null;

  // 负载（/proc/loadavg，Linux 原生）
  const [load_1m, load_5m, load_15m] = os.loadavg().map(r2);

  // 运行时间（秒）
  const uptime = Math.floor(os.uptime());

  return {
    cpu,
    mem_total, mem_used,
    disk_total, disk_used,
    temperature,
    load_1m, load_5m, load_15m,
    uptime,
  };
}

module.exports = { collect };
