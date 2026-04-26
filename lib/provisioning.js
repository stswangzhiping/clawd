'use strict';

const EventEmitter = require('events');
const log = require('./logger');
const { hasInternet, hasSavedWifiConnection, connectSavedWifiConnections, isWifiStaConnected, scanWifi, startAP, stopAP, connectWifi, getWifiIface, AP_IP } = require('./network');
const { DnsHijack }    = require('./dns-hijack');
const { CaptiveServer } = require('./captive-server');
const led = require('./led');

const MONITOR_INTERVAL_MS = 15_000;
const WIFI_RECONNECT_MAX_ROUNDS = 3;
const WIFI_RECONNECT_ROUND_DELAY_MS = 5_000;
const AP_SAVED_WIFI_RETRY_INTERVAL_MS = 180_000;
const AP_MIN_UP_BEFORE_RETRY_MS = 60_000;

/**
 * AP 常驻配网管理器。
 *
 * 规则：
 *   - 启动时：WiFi STA 优先；有已保存 WiFi 时主动让 NM 重连，最多 3 轮
 *   - 有线网络可用时：通知网络就绪，但不自动开启 AP
 *   - 自动开 AP 的唯一兜底：无有线/无 WiFi，且无 saved WiFi 或 saved WiFi 3 轮失败
 *   - 用户提交 WiFi 凭证 → 关 AP → 尝试连接 → 失败则按网络状态决定是否重新开 AP
 *   - AP 状态下：若仍无有线网络，低频释放 wlan0 并尝试 saved WiFi
 */
class ProvisionManager extends EventEmitter {
  constructor(clawId) {
    super();
    this._clawId = clawId || 'Setup';
    this._state  = 'idle'; // 'idle' | 'ap' | 'connecting' | 'sta' | 'wired'
    this._dns    = null;
    this._server = null;
    this._monitorTimer = null;
    this._monitorBusy = false;
    this._apStartedAt = 0;
    this._lastApSavedWifiRetryAt = 0;
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

    // 网络已就绪时先启动 WS；hasInternet() 可能来自 WiFi，也可能来自有线，不能直接当作 wired。
    if (hasInternet()) {
      if (isWifiStaConnected()) {
        this._state = 'sta';
        log.info('provision', 'WiFi STA 已连接，AP 不启动');
        this._emitNetworkReady();
      } else {
        this._state = 'wired';
        log.info('provision', '有线网络就绪，启动 WS；不自动开启 AP');
        led.off();
        this._emitNetworkReady();
      }
      this._startMonitor();
      return;
    }

    // 无有线可用时，有 saved WiFi 才主动让 NetworkManager 重连；不要只被动等待 NM autoconnect。
    if (hasSavedWifiConnection()) {
      log.info('provision', `发现已保存的 WiFi 配置，主动重连（最多 ${WIFI_RECONNECT_MAX_ROUNDS} 轮）...`);
      this._state = 'connecting';
      led.blink();
      const connected = await this._trySavedWifiReconnectRounds(WIFI_RECONNECT_MAX_ROUNDS);
      if (connected) {
        this._state = 'sta';
        log.info('provision', '已保存 WiFi 重连成功，AP 不启动');
        this._emitNetworkReady();
        this._startMonitor();
        return;
      }
      log.warn('provision', '已保存 WiFi 重连失败');
    }

    // 无有线、无 WiFi；且无 saved WiFi 或 saved WiFi 3 轮失败 → 开 AP 兜底配网。
    this._enterAP();
    this._startMonitor();
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

  async _trySavedWifiReconnectRounds(rounds = WIFI_RECONNECT_MAX_ROUNDS) {
    for (let i = 1; i <= rounds; i++) {
      if (isWifiStaConnected()) return true;
      log.info('provision', `尝试已保存 WiFi 重连：第 ${i}/${rounds} 轮`);
      const result = await connectSavedWifiConnections();
      if (result.success || isWifiStaConnected()) return true;
      if (i < rounds) {
        await new Promise((r) => setTimeout(r, WIFI_RECONNECT_ROUND_DELAY_MS));
      }
    }
    return false;
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
      // 若上次进程退出前留下 clawd-hotspot，必须先释放 wlan0；否则会在 AP 模式下扫描，列表可能只剩 2.4G/自身热点。
      stopAP();

      // AP 模式下无法扫描 WiFi，必须在开 AP 之前扫描并缓存
      log.info('provision', '扫描周边 WiFi...');
      this._cachedWifiList = scanWifi();
      log.info('provision', `扫描到 ${this._cachedWifiList.length} 个网络: ${this._cachedWifiList.map(w => `${w.ssid}${w.band ? `(${w.band})` : ''}`).join(', ')}`);

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
      this._apStartedAt = Date.now();
      this._lastApSavedWifiRetryAt = 0;
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

      log.warn('provision', `WiFi 连接失败: ${result.error}，按当前网络状态恢复`);
      this._recoverAfterWifiFailure();
      return result;
    } catch (e) {
      log.error('provision', `配网过程异常: ${e.message}`);
      this._recoverAfterWifiFailure();
      return { success: false, error: e.message };
    }
  }

  /** WiFi 连接失败后：有线可用则保持 wired；否则开 AP 兜底。 */
  _recoverAfterWifiFailure() {
    if (hasInternet()) {
      this._state = 'wired';
      led.off();
      this._emitNetworkReady();
      return;
    }
    this._safeReenterAP();
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
      if (this._monitorBusy) return;
      this._monitorBusy = true;
      this._monitorTick()
        .catch((e) => log.error('provision', `WiFi 状态监控异常: ${e.message}`))
        .finally(() => { this._monitorBusy = false; });
    }, MONITOR_INTERVAL_MS);
  }

  async _monitorTick() {
    if (this._state === 'connecting') return;

    const wifiUp = isWifiStaConnected();

    if (wifiUp && this._state !== 'sta') {
      if (this._state === 'ap') {
        log.info('provision', 'WiFi 已外部连接，关闭 AP');
        this._stopAPServices();
      }
      this._state = 'sta';
      this._emitNetworkReady();
    }

    if (this._state === 'sta' && !wifiUp) {
      log.warn('provision', 'WiFi 连接已断开，尝试恢复网络');
      await this._recoverNetworkWithoutWifi();
      return;
    }

    if (this._state === 'wired') {
      if (!hasInternet()) {
        log.warn('provision', '有线网络不可用，尝试恢复 WiFi');
        await this._recoverNetworkWithoutWifi();
        return;
      }
      led.off();
      return;
    }

    if (this._state === 'ap') {
      if (hasInternet()) {
        log.info('provision', '检测到有线网络可用，关闭 AP');
        this._stopAPServices();
        this._state = 'wired';
        this._emitNetworkReady();
        return;
      }

      if (hasSavedWifiConnection() && this._shouldRetrySavedWifiFromAP()) {
        await this._retrySavedWifiFromAP();
        return;
      }
      led.off();
      return;
    }
  }

  async _recoverNetworkWithoutWifi() {
    this._state = 'connecting';
    led.blink();

    if (hasSavedWifiConnection()) {
      const connected = await this._trySavedWifiReconnectRounds(WIFI_RECONNECT_MAX_ROUNDS);
      if (connected) {
        this._state = 'sta';
        this._emitNetworkReady();
        return;
      }
    }

    if (hasInternet()) {
      this._state = 'wired';
      led.off();
      this._emitNetworkReady();
      return;
    }

    this._safeReenterAP();
  }

  _shouldRetrySavedWifiFromAP() {
    const now = Date.now();
    if (this._apStartedAt && now - this._apStartedAt < AP_MIN_UP_BEFORE_RETRY_MS) return false;
    if (this._lastApSavedWifiRetryAt && now - this._lastApSavedWifiRetryAt < AP_SAVED_WIFI_RETRY_INTERVAL_MS) return false;
    return true;
  }

  async _retrySavedWifiFromAP() {
    this._lastApSavedWifiRetryAt = Date.now();
    log.info('provision', 'AP 模式下定期尝试已保存 WiFi');
    this._state = 'connecting';
    led.blink();
    this._stopAPServices();
    await new Promise((r) => setTimeout(r, 3500));

    const connected = await this._trySavedWifiReconnectRounds(WIFI_RECONNECT_MAX_ROUNDS);
    if (connected) {
      this._state = 'sta';
      this._emitNetworkReady();
      return;
    }

    if (hasInternet()) {
      this._state = 'wired';
      led.off();
      this._emitNetworkReady();
      return;
    }

    log.warn('provision', 'AP 模式下重试已保存 WiFi 失败，恢复 AP');
    this._safeReenterAP();
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
