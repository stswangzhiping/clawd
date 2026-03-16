'use strict';

const log = require('./logger');
const { hasInternet, startAP, stopAP, AP_IP } = require('./network');
const { DnsHijack }     = require('./dns-hijack');
const { CaptiveServer }  = require('./captive-server');

const config = require('./config');

const MAX_RETRIES = 3; // 配网连接失败后最多重新进入 AP 模式次数

/**
 * 确保设备有互联网连接。
 * 已联网 → 直接返回
 * 未联网 → 进入 AP 配网模式 → 等待用户配网 → 成功后返回
 *
 * @param {object} opts
 * @param {string|number} opts.clawId - 设备 ID（用于 AP SSID）
 * @returns {Promise<void>}
 */
async function ensureNetwork(opts = {}) {
  // 先检测是否已联网
  if (hasInternet()) {
    log.info('provision', '网络已就绪，跳过配网');
    return;
  }

  log.warn('provision', '未检测到网络，进入配网模式...');

  const cfg = config.load();
  const clawId = opts.clawId || cfg.claw_id || 'Setup';
  let retries = 0;

  while (retries < MAX_RETRIES) {
    try {
      await runProvisioningRound(clawId);

      // 配网成功，再验证一次
      if (hasInternet()) {
        log.info('provision', '配网完成，网络已就绪');
        return;
      }

      log.warn('provision', '配网后仍无网络，重新进入配网模式...');
    } catch (e) {
      log.error('provision', `配网异常: ${e.message}`);
    }

    retries++;
    if (retries < MAX_RETRIES) {
      log.info('provision', `重试配网 (${retries}/${MAX_RETRIES})...`);
      // 等一会再重试，避免过快循环
      await sleep(3000);
    }
  }

  log.error('provision', `配网失败 ${MAX_RETRIES} 次，将以离线模式继续启动（等待网络恢复后重连）`);
}

/**
 * 单轮配网流程：开 AP → 启动 DNS + HTTP → 等待用户配网 → 清理
 */
async function runProvisioningRound(clawId) {
  const dns    = new DnsHijack();
  const server = new CaptiveServer({ clawId });

  try {
    // 1. 启动 WiFi AP
    const ap = startAP(clawId);

    // 2. 启动 DNS 劫持
    dns.start(ap.iface, AP_IP);

    // 3. 启动 HTTP 配网页面，等待用户完成配网
    //    server.start() 返回 Promise，配网成功时 resolve
    log.info('provision', '配网页面已就绪，等待用户操作...');
    log.info('provision', `用户请连接 WiFi "${ap.ssid}" 并访问 http://ap.cutos.ai`);

    const result = await server.start();
    log.info('provision', `用户已连接 WiFi: ${result.ssid}`);
  } finally {
    // 清理：无论成功失败都关闭 AP / DNS / HTTP
    server.stop();
    dns.stop();
    stopAP();
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { ensureNetwork };
