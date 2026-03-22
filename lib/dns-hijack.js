'use strict';

const fs   = require('fs');
const path = require('path');
const log  = require('./logger');

const CAPTIVE_DOMAIN = '10.42.0.1';

const NM_DNSMASQ_DIR  = '/etc/NetworkManager/dnsmasq-shared.d';
const CAPTIVE_CONF    = path.join(NM_DNSMASQ_DIR, 'clawd-captive.conf');

/**
 * DNS 劫持管理。
 *
 * 利用 NM 的 dnsmasq-shared.d 配置目录实现全域 DNS 劫持。
 * 配置文件由 install.sh 预写（避免运行时 EROFS），
 * 运行时仅做验证和兜底写入。
 */
class DnsHijack {
  constructor() {
    this._active = false;
  }

  start(_iface, gatewayIp) {
    const conf = `# clawd captive portal DNS hijack\naddress=/#/${gatewayIp}\n`;

    // 尝试写入（可能成功也可能 EROFS）
    try {
      fs.mkdirSync(NM_DNSMASQ_DIR, { recursive: true });
      fs.writeFileSync(CAPTIVE_CONF, conf, 'utf8');
      log.info('dns', `DNS 劫持配置已写入: ${CAPTIVE_CONF}`);
    } catch (e) {
      if (fs.existsSync(CAPTIVE_CONF)) {
        log.info('dns', 'DNS 劫持配置已存在（install.sh 预写），跳过写入');
      } else {
        log.error('dns', `DNS 劫持配置写入失败且不存在: ${e.message}`);
        log.error('dns', '请重新运行 install.sh 写入配置');
      }
    }
    this._active = true;
  }

  stop() {
    // 不删除配置文件（保持预写状态，下次启动无需重写）
    this._active = false;
  }
}

module.exports = { DnsHijack, CAPTIVE_DOMAIN };
