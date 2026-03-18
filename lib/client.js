'use strict';

const WebSocket = require('ws');
const { execFileSync } = require('child_process');
const config    = require('./config');
const log       = require('./logger');
const { getBoxId }        = require('./fingerprint');
const { collect }         = require('./metrics');
const { getDashboardInfo, startTtyd, FrpcManager } = require('./frpc');  // getDashboardInfo 也用于心跳中定期刷新
const { ProvisionManager } = require('./provisioning');
const { hasInternet }      = require('./network');
const led = require('./led');

const MAX_BACKOFF_MS   = 60_000;
const PONG_TIMEOUT_MS  = 15_000;
const PING_INTERVAL_MS = 30_000;

// systemd watchdog: 如果 WatchdogSec 存在，定期发 WATCHDOG=1
const SD_WATCHDOG_USEC = parseInt(process.env.WATCHDOG_USEC || '0', 10);
const SD_NOTIFY_INTERVAL = SD_WATCHDOG_USEC > 0
  ? Math.floor(SD_WATCHDOG_USEC / 2 / 1000) // 半周期通知（μs → ms）
  : 0;

class ClawClient {
  constructor() {
    this._cfg     = config.load();
    this._boxId   = getBoxId();
    this._ws      = null;
    this._hbTimer = null;
    this._backoff = 1_000;
    this._stopped = false;
    this._frpc    = new FrpcManager();
    this._dashInfo = {};
    this._hbCount  = 0;    // 心跳计数器，用于定期刷新 dashboard 信息

    // WS 层活性检测
    this._pingTimer       = null;
    this._awaitingPong    = false;

    // systemd watchdog
    this._sdTimer = null;

    this._setupGlobalHandlers();
  }

  // ── 全局异常兜底 ─────────────────────────────────────────────────────────────

  _setupGlobalHandlers() {
    process.on('uncaughtException', (err) => {
      log.error('process', '未捕获异常:', err);
      // 给日志写盘的时间，然后退出让 systemd 重启
      setTimeout(() => process.exit(1), 1000);
    });

    process.on('unhandledRejection', (reason) => {
      log.error('process', '未处理的 Promise 拒绝:', reason);
    });
  }

  // ── 生命周期 ─────────────────────────────────────────────────────────────────

  async start() {
    log.info('clawd', `启动中... 服务器 = ${this._cfg.server}`);

    // 启动时默认 SETUP 亮（未激活状态），连接成功后按实际状态切换
    led.status.setSetup();

    this._startSdNotify();

    // 启动 AP 配网管理器（等待已保存 WiFi 自动连接，超时再开 AP）
    this._provisionMgr = new ProvisionManager(this._cfg.claw_id);
    this._connectionStarted = false;

    // 网络就绪时连接云端（仅触发一次）
    this._provisionMgr.on('network-ready', () => {
      if (!this._connectionStarted) {
        this._connectionStarted = true;
        this._proceedWithConnection().catch(e => {
          log.error('clawd', '连接启动失败:', e.message);
        });
      }
    });

    await this._provisionMgr.start();

    // start() 返回后，如果已有网络且尚未启动连接
    if (hasInternet() && !this._connectionStarted) {
      this._connectionStarted = true;
      await this._proceedWithConnection();
    } else if (!hasInternet()) {
      log.info('clawd', '等待网络就绪（WiFi 配网或网线接入）...');
    }
  }

  async _proceedWithConnection() {
    const [dashInfo] = await Promise.all([
      getDashboardInfo().catch(e => { log.warn('clawd', 'dashboard 信息获取失败:', e.message); return null; }),
      startTtyd().catch(e => log.warn('ttyd', '启动失败:', e.message)),
    ]);
    this._dashInfo = dashInfo || {};
    this._connect();
  }

  stop() {
    this._stopped = true;
    this._clearHeartbeat();
    this._clearPing();
    if (this._sdTimer) { clearInterval(this._sdTimer); this._sdTimer = null; }
    if (this._provisionMgr) { this._provisionMgr.stop(); this._provisionMgr = null; }
    this._frpc.stop();
    if (this._ws) this._ws.terminate();
    led.status.off(); // 进程退出，两灯全灭
    this._sdNotify('STOPPING=1');
    log.info('clawd', '已停止');
    log.close();
  }

  // ── WebSocket 连接 ──────────────────────────────────────────────────────────

  _connect() {
    if (this._stopped) return;

    log.info('clawd', `正在连接 ${this._cfg.server} ...`);
    const ws = new WebSocket(this._cfg.server, {
      handshakeTimeout: 10_000,
    });
    this._ws = ws;

    ws.on('open', () => {
      log.info('clawd', 'WebSocket 已连接');
      this._backoff = 1_000;
      this._sendConnect();
      this._startPing();
      // 显示由 _onConnected 根据 status 设置，不在此处提前 showTime
    });

    ws.on('message', (data) => {
      try {
        this._handleMessage(JSON.parse(data.toString()));
      } catch (e) {
        log.error('clawd', '消息解析失败:', e.message);
      }
    });

    ws.on('pong', () => {
      this._awaitingPong = false;
    });

    ws.on('close', (code, reason) => {
      this._clearHeartbeat();
      this._clearPing();
      if (!this._stopped) {
        log.warn('clawd', `连接断开 (${code})，${this._backoff / 1000}s 后重连...`);
        led.display.showAP(); // 断开云端 → 显示 AP
        setTimeout(() => this._connect(), this._backoff);
        this._backoff = Math.min(this._backoff * 2, MAX_BACKOFF_MS);
      }
    });

    ws.on('error', (err) => {
      log.error('clawd', '连接错误:', err.message);
    });
  }

  // ── WS 层 Ping/Pong 活性检测 ──────────────────────────────────────────────

  _startPing() {
    this._clearPing();
    this._pingTimer = setInterval(() => {
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;

      if (this._awaitingPong) {
        log.warn('clawd', 'Pong 超时，连接可能已死，主动关闭重连');
        this._ws.terminate();
        return;
      }

      this._awaitingPong = true;
      try { this._ws.ping(); } catch (_) {}
    }, PING_INTERVAL_MS);
  }

  _clearPing() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
    this._awaitingPong = false;
  }

  // ── 发送 connect ─────────────────────────────────────────────────────────────

  _sendConnect() {
    const msg = {
      type:    'connect',
      box_id:  this._boxId,
      claw_id: this._cfg.claw_id  ?? null,
      token:   this._cfg.token    ?? null,
      ...this._dashInfo,
    };
    this._send(msg);
  }

  // ── 消息处理 ─────────────────────────────────────────────────────────────────

  _handleMessage(msg) {
    switch (msg.type) {
      case 'connected':
        this._onConnected(msg);
        break;
      case 'heartbeat_ack':
        break;
      case 'error':
        log.error('clawd', `服务器错误: ${msg.msg}`);
        if (msg.msg === 'hardware_mismatch') {
          log.warn('clawd', '硬件指纹不符，清除凭证重新注册...');
          this._cfg.claw_id = null;
          this._cfg.token   = null;
          config.save(this._cfg);
        } else if (msg.msg && msg.msg.includes('invalid')) {
          log.warn('clawd', '凭证无效，清除凭证重新注册...');
          this._cfg.claw_id = null;
          this._cfg.token   = null;
          config.save(this._cfg);
        }
        break;
      default:
        log.warn('clawd', '未知消息类型:', msg.type);
    }
  }

  _onConnected(msg) {
    const isNew = !this._cfg.claw_id;

    this._cfg.claw_id = msg.claw_id;
    this._cfg.token   = msg.token;
    config.save(this._cfg);

    if (isNew) {
      log.info('clawd', `注册成功！claw_id = ${msg.claw_id}`);
    }

    if (msg.status === 'inactive') {
      led.status.setSetup(); // 未激活 → SETUP 亮
      led.display.showPinMiddle4(msg.pin); // 未激活 + 连网 → 显示 PIN 中间4位
      const id  = String(msg.claw_id).padEnd(6);
      const pin = String(msg.pin);
      log.info('clawd', '');
      log.info('clawd', '╔════════════════════════════════════╗');
      log.info('clawd', `║  Claw ID : ${id}                  ║`);
      log.info('clawd', `║  PIN 码  : ${pin}                  ║`);
      log.info('clawd', '║  请在网页前台「添加设备」中输入    ║');
      log.info('clawd', '╚════════════════════════════════════╝');
      log.info('clawd', '');
      log.info('clawd', '等待激活，心跳正常运行...');
    } else {
      led.status.setApps(); // 已激活 → APPS 亮
      led.display.showTime(); // 已激活 → 显示时间
      log.info('clawd', `已激活  claw_id = ${msg.claw_id}`);
    }

    if (msg.frp && msg.frp.server && msg.frp.auth_token) {
      this._frpc.start(msg.claw_id, msg.frp).catch(e => {
        log.error('frpc', '启动失败:', e.message);
      });
    }

    this._startHeartbeat();
  }

  // ── 心跳 ────────────────────────────────────────────────────────────────────

  _startHeartbeat() {
    this._clearHeartbeat();
    const interval = (this._cfg.heartbeat_interval || 30) * 1000;
    this._sendHeartbeat();
    this._hbTimer = setInterval(() => this._sendHeartbeat(), interval);
  }

  async _sendHeartbeat() {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    try {
      this._hbCount++;

      // 每 10 次心跳（约 5 分钟）刷新一次 dashboard 信息，
      // 确保初次提取失败时能自动补偿，或在 token 变化后自动同步
      if (this._hbCount % 10 === 0) {
        const freshInfo = await getDashboardInfo().catch(() => null);
        if (freshInfo && Object.keys(freshInfo).length > 0) {
          this._dashInfo = freshInfo;
        }
      }

      const metrics = await collect();
      this._send({
        type:    'heartbeat',
        claw_id: this._cfg.claw_id,
        token:   this._cfg.token,
        metrics,
        ...this._dashInfo,   // 携带 dashboard_token / dashboard_port，供 VPS 幂等更新
      });
    } catch (e) {
      log.error('clawd', '心跳发送失败:', e.message);
    }
  }

  _clearHeartbeat() {
    if (this._hbTimer) {
      clearInterval(this._hbTimer);
      this._hbTimer = null;
    }
  }

  // ── 工具 ────────────────────────────────────────────────────────────────────

  _send(obj) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(obj));
    }
  }

  // ── systemd Watchdog ────────────────────────────────────────────────────────

  _startSdNotify() {
    if (!SD_NOTIFY_INTERVAL) return;

    log.debug('clawd', `systemd watchdog 启用，通知间隔 ${SD_NOTIFY_INTERVAL}ms`);
    this._sdNotify('READY=1');
    this._sdTimer = setInterval(() => this._sdNotify('WATCHDOG=1'), SD_NOTIFY_INTERVAL);
  }

  _sdNotify(msg) {
    if (!process.env.NOTIFY_SOCKET) return;
    try {
      execFileSync('systemd-notify', ['--pid=' + process.pid, msg], { timeout: 2000 });
    } catch (_) {
      // systemd-notify 不可用时静默忽略
    }
  }
}

module.exports = { ClawClient };
