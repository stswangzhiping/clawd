'use strict';

const fs   = require('fs');
const path = require('path');
const log  = require('./logger');

const CAPTIVE_DOMAIN = 'ap.cutos.ai';

// NetworkManager 的 dnsmasq 共享配置目录
// NM 启动热点时会自动加载此目录下的 .conf 文件
const NM_DNSMASQ_DIR  = '/etc/NetworkManager/dnsmasq-shared.d';
const CAPTIVE_CONF    = path.join(NM_DNSMASQ_DIR, 'clawd-captive.conf');

/**
 * 通过 NetworkManager 的 dnsmasq 配置实现 DNS 劫持。
 *
 * NM 在创建热点时自动启动 dnsmasq 并加载 dnsmasq-shared.d/ 下的配置。
 * 我们只需在启动热点前写入 address=/#/gatewayIp，NM 的 dnsmasq 就会
 * 把所有域名解析到网关 IP，触发 Captive Portal 检测。
 *
 * 不再自行管理 dnsmasq 进程，避免与 NM 冲突导致热点被拆除。
 */
class DnsHijack {
  constructor() {
    this._active = false;
  }

  /**
   * 写入 DNS 劫持配置（需在 startAP 之前调用）
   * @param {string} _iface - 接口名（保留参数，兼容调用）
   * @param {string} gatewayIp - 网关 IP（如 10.42.0.1）
   */
  start(_iface, gatewayIp) {
    this.stop();

    const conf = [
      `# clawd captive portal DNS hijack`,
      `# All DNS queries resolve to gateway to trigger captive portal`,
      `address=/#/${gatewayIp}`,
    ].join('\n');

    try {
      fs.mkdirSync(NM_DNSMASQ_DIR, { recursive: true });
      fs.writeFileSync(CAPTIVE_CONF, conf, 'utf8');
      this._active = true;
      log.info('dns', `DNS 劫持配置已写入: ${CAPTIVE_CONF} (${CAPTIVE_DOMAIN} → ${gatewayIp})`);
    } catch (e) {
      log.error('dns', `写入 DNS 劫持配置失败: ${e.message}`);
    }
  }

  stop() {
    if (this._active) {
      try { fs.unlinkSync(CAPTIVE_CONF); } catch (_) {}
      this._active = false;
      log.info('dns', 'DNS 劫持配置已移除');
    }
  }
}

module.exports = { DnsHijack, CAPTIVE_DOMAIN };
