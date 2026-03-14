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

  // 内存（bytes → KB）
  const memVal = mem.status === 'fulfilled' ? mem.value : {};
  const mem_total = toKB(memVal.total);
  const mem_used  = toKB(memVal.used);

  // 磁盘：取挂载根目录 "/" 或第一个条目
  let disk_total = null, disk_used = null;
  if (fsArr.status === 'fulfilled' && fsArr.value.length > 0) {
    const root = fsArr.value.find(f => f.mount === '/') || fsArr.value[0];
    disk_total = toKB(root.size);
    disk_used  = toKB(root.used);
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
