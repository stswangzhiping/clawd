'use strict';

const EventEmitter = require('events');
const log = require('./logger');
const { hasInternet, hasSavedWifiConnection, isWifiStaConnected, scanWifi, startAP, stopAP, connectWifi, getWifiIface, AP_IP } = require('./network');
const { DnsHijack }    = require('./dns-hijack');
const { CaptiveServer } = require('./captive-server');
const led = require('./led');

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

  /** 是否正处于 AP 模式（WiFi 热点广播中） */
  isApMode() { return this._state === 'ap'; }

  async start() {
    led.off(); // WiFi 灯初始状态：熄灭

    // WiFi STA 已连接 → 直接进入 STA 模式
    if (isWifiStaConnected()) {
      this._state = 'sta';
      log.info('provision', 'WiFi STA 已连接，AP 不启动');
      this._emitNetworkReady();
      this._startMonitor();
      return;
    }

    // 有线有网 → 立即通知 WS 连接，后台异步设置 AP 供 WiFi 配网
    if (hasInternet()) {
      log.info('provision', '有线网络就绪，立即启动 WS，AP 后台准备中...');
      this._emitNetworkReady();
      setTimeout(() => {
        this._enterAP();
        this._startMonitor();
      }, 0);
      return;
    }

    // 无网：有已保存的 WiFi 配置 → 等 NM 自动连接（重启场景）
    if (hasSavedWifiConnection()) {
      log.info('provision', '发现已保存的 WiFi 配置，等待 NetworkManager 自动连接...');
      led.blink(); // WiFi 灯：等待自动重连期间闪烁
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
    if (hasInternet()) {
      // WiFi 灯只在 STA 模式下亮（有线有网而 WiFi 在 AP 模式时不亮）
      if (this._state === 'sta') led.on();
      this.emit('network-ready');
    } else {
      log.warn('provision', 'hasInternet() 返回 false，LED 保持熄灭');
    }
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
    led.destroy(); // WiFi 灯：停止时关灯、释放闪烁定时器
  }

  // ── 进入 AP 模式 ─────────────────────────────────────────────────────────

  _enterAP() {
    if (this._state === 'ap') return;

    led.off(); // AP 模式：WiFi 未连接，WiFi 灯熄灭
    if (!hasInternet()) led.display.showAP(); // 无网时立即显示 AP，有线时等 WS 连接后再定

    try {
      // AP 模式下无法扫描 WiFi，必须在开 AP 之前扫描并缓存
      log.info('provision', '扫描周边 WiFi...');
      this._cachedWifiList = scanWifi();
      log.info('provision', `扫描到 ${this._cachedWifiList.length} 个网络`);

      // 写 DNS 劫持配置（NM 启动热点时加载）；接口名与热点一致，勿写死 wlan0
      this._dns = new DnsHijack();
      this._dns.start(getWifiIface(), AP_IP);

      const ap = startAP(this._clawId);

      this._server = new CaptiveServer({
        clawId: this._clawId,
        cachedWifiList: this._cachedWifiList,
        onConnect: (ssid, password) => this._handleWifiConnect(ssid, password),
      });
      this._server.startListening();

      this._state = 'ap';
      log.info('provision', `AP 常驻模式已启动: ${ap.ssid}, 密码 12345678`);
      log.info('provision', `配网地址: http://10.42.0.1`);
    } catch (e) {
      log.error('provision', `AP 启动失败: ${e.message}`);
      if (this._state !== 'sta') this._state = 'idle';
    }
  }

  // ── 用户提交 WiFi 凭证 ───────────────────────────────────────────────────

  async _handleWifiConnect(ssid, password) {
    if (this._state === 'connecting') return { success: false, error: '正在连接中，请稍候' };

    this._state = 'connecting';
    log.info('provision', `用户请求连接 WiFi: ${ssid}`);
    led.blink(); // 正在连接 → 闪烁

    try {
      this._stopAPServices();

      // 关热点后射频/模式切换需要时间，立刻 connect 在部分板子上会失败
      await new Promise((r) => setTimeout(r, 3500));

      const result = await connectWifi(ssid, password);

      if (result.success) {
        this._state = 'sta';
        log.info('provision', `WiFi 已连接: ${ssid}`);
        led.on(); // WiFi 灯：连接成功 → 常亮
        this.emit('network-ready');
        return result;
      }

      log.warn('provision', `WiFi 连接失败: ${result.error}，重新启动 AP`);
      this._safeReenterAP();
      return result;
    } catch (e) {
      log.error('provision', `配网过程异常: ${e.message}`);
      this._safeReenterAP();
      return { success: false, error: e.message };
    }
  }

  /** 重新开 AP；失败时勿把 _state 永久卡在 connecting */
  _safeReenterAP() {
    try {
      this._enterAP();
    } catch (e) {
      log.error('provision', `重新启动 AP 失败: ${e.message}`);
      this._state = 'idle';
    }
  }

  // ── WiFi 状态监控 ─────────────────────────────────────────────────────────

  _startMonitor() {
    this._monitorTimer = setInterval(() => {
      if (this._state === 'connecting') return;

      const wifiUp = isWifiStaConnected();

      if (this._state === 'sta' && !wifiUp) {
        log.warn('provision', 'WiFi 连接已断开，重新启动 AP');
        this._enterAP(); // 内部调用 led.off()
        return;
      }

      if (this._state === 'ap' && wifiUp) {
        log.info('provision', 'WiFi 已外部连接，关闭 AP');
        this._stopAPServices();
        this._state = 'sta';
        this.emit('network-ready');
      }

      // 产品 WiFi 灯（OpenVFD wifi+eth）：AP 全程强制熄灭，避免与其它逻辑竞态导致误亮
      if (this._state === 'ap') {
        led.off();
      } else if (this._state === 'sta') {
        if (hasInternet()) {
          led.on();
        } else {
          led.off(); // STA 已连热点但无互联网
        }
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
