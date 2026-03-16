'use strict';

const { spawn, execSync } = require('child_process');
const fs  = require('fs');
const os  = require('os');
const path = require('path');
const log = require('./logger');
const { Watchdog } = require('./watchdog');

const CONFIG_DIR = process.env.CLAWD_CONFIG_DIR
  || (process.getuid && process.getuid() === 0 ? '/etc/clawd' : path.join(os.homedir(), '.clawd'));

const DNSMASQ_CONF = path.join(CONFIG_DIR, 'dnsmasq-captive.conf');
const CAPTIVE_DOMAIN = 'ap.cutos.ai';

/**
 * 管理 dnsmasq 进程：
 *   - 所有 DNS 查询 → 网关 IP（触发 Captive Portal 弹窗）
 *   - DHCP 分配 10.42.0.50 ~ 10.42.0.150
 *   - ap.cutos.ai 专门指向网关
 */
class DnsHijack {
  constructor() {
    this._watchdog = null;
  }

  /**
   * 启动 dnsmasq
   * @param {string} iface - AP 接口名（如 wlan0）
   * @param {string} gatewayIp - 网关 IP（如 10.42.0.1）
   */
  start(iface, gatewayIp) {
    this.stop();

    const rangeStart = gatewayIp.replace(/\.\d+$/, '.50');
    const rangeEnd   = gatewayIp.replace(/\.\d+$/, '.150');

    const conf = [
      `interface=${iface}`,
      'bind-interfaces',
      `listen-address=${gatewayIp}`,
      '',
      '# DHCP',
      `dhcp-range=${rangeStart},${rangeEnd},255.255.255.0,12h`,
      `dhcp-option=3,${gatewayIp}`,   // gateway
      `dhcp-option=6,${gatewayIp}`,   // DNS server
      '',
      '# DNS: 所有域名指向网关（触发 Captive Portal 检测）',
      `address=/#/${gatewayIp}`,
      '',
      '# 日志',
      'log-queries',
      'log-facility=-',  // stdout → Watchdog 采集
      '',
      '# 禁用系统 resolv.conf',
      'no-resolv',
      'no-poll',
    ].join('\n');

    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(DNSMASQ_CONF, conf, 'utf8');
    log.info('dns', `dnsmasq 配置已写入: ${DNSMASQ_CONF}`);

    // 终止系统可能残留的 dnsmasq
    try { execSync('pkill -f "dnsmasq.*clawd"', { timeout: 3000 }); } catch (_) {}

    // 检查 dnsmasq 是否安装
    try {
      execSync('which dnsmasq', { timeout: 3000 });
    } catch (_) {
      log.error('dns', 'dnsmasq 未安装，请运行: apt install dnsmasq');
      return;
    }

    this._watchdog = new Watchdog('dns', 'dnsmasq', [
      '--no-daemon',
      `--conf-file=${DNSMASQ_CONF}`,
    ], {
      maxRestarts:  5,
      windowMs:     60_000,
      restartDelay: 2_000,
      onStdout: (line) => log.debug('dns', line),
      onStderr: (line) => log.debug('dns', line),
    });
    this._watchdog.start();
    log.info('dns', `dnsmasq 已启动: ${CAPTIVE_DOMAIN} → ${gatewayIp}, 全域劫持`);
  }

  stop() {
    if (this._watchdog) {
      this._watchdog.stop();
      this._watchdog = null;
    }
    try { execSync('pkill -f "dnsmasq.*clawd"', { timeout: 3000 }); } catch (_) {}
    try { fs.unlinkSync(DNSMASQ_CONF); } catch (_) {}
  }
}

module.exports = { DnsHijack, CAPTIVE_DOMAIN };
