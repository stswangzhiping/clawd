'use strict';

const EventEmitter = require('events');
const log = require('./logger');
const { hasInternet, hasSavedWifiConnection, isWifiStaConnected, startAP, stopAP, connectWifi, AP_IP } = require('./network');
const { DnsHijack }    = require('./dns-hijack');
const { CaptiveServer } = require('./captive-server');

const MONITOR_INTERVAL_MS = 30_000;
const BOOT_WAIT_MAX_MS    = 20_000; // 等待 NM 自动连接的最大时间
const BOOT_POLL_MS        = 2_000;  // 轮询间隔

/**
 * AP 常驻配网管理器。
 *
 * 规则：
 *   - 启动时：有已保存 WiFi 配置 → 等 NM 自动连接（最多 20 秒）
 *   - wlan0 没有以 STA 模式连接 WiFi → 开 AP + DNS 劫持 + HTTP 配网页
 *   - 用户提交 WiFi 凭证 → 关 AP → 尝试连接 → 失败则重新开 AP
 *   - 运行中 WiFi 断开 → 自动重新开 AP
 *   - WiFi 已连接 → AP 关闭
 */
class ProvisionManager extends EventEmitter {
  constructor(clawId) {
    super();
    this._clawId = clawId || 'Setup';
    this._state  = 'idle'; // 'idle' | 'ap' | 'connecting' | 'sta'
    this._dns    = null;
    this._server = null;
    this._monitorTimer = null;
  }

  async start() {
    // WiFi 已连接 → 直接进入 STA 模式
    if (isWifiStaConnected()) {
      this._state = 'sta';
      log.info('provision', 'WiFi STA 已连接，AP 不启动');
      this._emitNetworkReady();
      this._startMonitor();
      return;
    }

    // 有已保存的 WiFi 配置 → 等 NM 自动连接（重启场景）
    if (hasSavedWifiConnection()) {
      log.info('provision', '发现已保存的 WiFi 配置，等待 NetworkManager 自动连接...');
      const connected = await this._waitForWifiConnect();
      if (connected) {
        this._state = 'sta';
        log.info('provision', 'WiFi 自动连接成功，AP 不启动');
        this._emitNetworkReady();
        this._startMonitor();
        return;
      }
      log.warn('provision', 'WiFi 自动连接超时，启动 AP');
    }

    // 没有已保存 WiFi 或等待超时 → 开 AP
    this._enterAP();
    this._startMonitor();

    if (hasInternet()) {
      this._emitNetworkReady();
    }
  }

  _emitNetworkReady() {
    if (hasInternet()) this.emit('network-ready');
  }

  /**
   * 轮询等待 NM 自动连接 WiFi，最多等 BOOT_WAIT_MAX_MS
   */
  _waitForWifiConnect() {
    return new Promise(resolve => {
      let elapsed = 0;
      const timer = setInterval(() => {
        elapsed += BOOT_POLL_MS;
        if (isWifiStaConnected()) {
          clearInterval(timer);
          resolve(true);
        } else if (elapsed >= BOOT_WAIT_MAX_MS) {
          clearInterval(timer);
          resolve(false);
        }
      }, BOOT_POLL_MS);
    });
  }

  stop() {
    this._stopMonitor();
    this._stopAll();
    this._state = 'idle';
  }

  // ── 进入 AP 模式 ─────────────────────────────────────────────────────────

  _enterAP() {
    if (this._state === 'ap') return;

    try {
      const ap = startAP(this._clawId);

      this._dns = new DnsHijack();
      this._dns.start(ap.iface, AP_IP);

      this._server = new CaptiveServer({
        clawId: this._clawId,
        onConnect: (ssid, password) => this._handleWifiConnect(ssid, password),
      });
      this._server.startListening();

      this._state = 'ap';
      log.info('provision', `AP 常驻模式已启动: ${ap.ssid}, 密码 12345678`);
      log.info('provision', `配网地址: http://ap.cutos.ai`);
    } catch (e) {
      log.error('provision', `AP 启动失败: ${e.message}`);
    }
  }

  // ── 用户提交 WiFi 凭证 ───────────────────────────────────────────────────

  async _handleWifiConnect(ssid, password) {
    if (this._state === 'connecting') return { success: false, error: '正在连接中，请稍候' };

    this._state = 'connecting';
    log.info('provision', `用户请求连接 WiFi: ${ssid}`);

    this._stopAPServices();

    const result = connectWifi(ssid, password);

    if (result.success) {
      this._state = 'sta';
      log.info('provision', `WiFi 已连接: ${ssid}`);
      this.emit('network-ready');
      return result;
    }

    log.warn('provision', `WiFi 连接失败: ${result.error}，重新启动 AP`);
    this._enterAP();
    return result;
  }

  // ── WiFi 状态监控 ─────────────────────────────────────────────────────────

  _startMonitor() {
    this._monitorTimer = setInterval(() => {
      if (this._state === 'connecting') return;

      const wifiUp = isWifiStaConnected();

      if (this._state === 'sta' && !wifiUp) {
        log.warn('provision', 'WiFi 连接已断开，重新启动 AP');
        this._enterAP();
      }

      if (this._state === 'ap' && wifiUp) {
        log.info('provision', 'WiFi 已外部连接，关闭 AP');
        this._stopAPServices();
        this._state = 'sta';
        this.emit('network-ready');
      }
    }, MONITOR_INTERVAL_MS);
  }

  _stopMonitor() {
    if (this._monitorTimer) {
      clearInterval(this._monitorTimer);
      this._monitorTimer = null;
    }
  }

  // ── 清理 ──────────────────────────────────────────────────────────────────

  _stopAPServices() {
    if (this._server) {
      this._server.stop();
      this._server = null;
    }
    if (this._dns) {
      this._dns.stop();
      this._dns = null;
    }
    stopAP();
  }

  _stopAll() {
    this._stopAPServices();
  }
}

module.exports = { ProvisionManager };
