'use strict';

const WebSocket = require('ws');
const config    = require('./config');
const { getBoxId }  = require('./fingerprint');
const { collect }   = require('./metrics');

const MAX_BACKOFF_MS = 60_000;

class ClawClient {
  constructor() {
    this._cfg     = config.load();
    this._boxId   = getBoxId();
    this._ws      = null;
    this._hbTimer = null;   // 心跳定时器
    this._backoff = 1_000;  // 重连等待（ms）
    this._stopped = false;
  }

  start() {
    console.log(`[clawd] 启动中... 服务器 = ${this._cfg.server}`);
    this._connect();
  }

  stop() {
    this._stopped = true;
    this._clearHeartbeat();
    if (this._ws) this._ws.terminate();
    console.log('[clawd] 已停止');
  }

  // ── 连接 ──────────────────────────────────────────────────────────────────

  _connect() {
    if (this._stopped) return;

    console.log(`[clawd] 正在连接 ${this._cfg.server} ...`);
    const ws = new WebSocket(this._cfg.server, {
      handshakeTimeout: 10_000,
    });
    this._ws = ws;

    ws.on('open', () => {
      console.log('[clawd] WebSocket 已连接');
      this._backoff = 1_000;
      this._sendConnect();
    });

    ws.on('message', (data) => {
      try {
        this._handleMessage(JSON.parse(data.toString()));
      } catch (e) {
        console.error('[clawd] 消息解析失败:', e.message);
      }
    });

    ws.on('close', (code, reason) => {
      this._clearHeartbeat();
      if (!this._stopped) {
        console.warn(`[clawd] 连接断开 (${code})，${this._backoff / 1000}s 后重连...`);
        setTimeout(() => this._connect(), this._backoff);
        this._backoff = Math.min(this._backoff * 2, MAX_BACKOFF_MS);
      }
    });

    ws.on('error', (err) => {
      console.error('[clawd] 连接错误:', err.message);
      // close 事件会在 error 之后触发，重连逻辑在 close 里处理
    });
  }

  // ── 发送 connect ──────────────────────────────────────────────────────────

  _sendConnect() {
    const msg = {
      type:    'connect',
      box_id:  this._boxId,
      claw_id: this._cfg.claw_id  ?? null,
      token:   this._cfg.token    ?? null,
    };
    this._send(msg);
  }

  // ── 消息处理 ──────────────────────────────────────────────────────────────

  _handleMessage(msg) {
    switch (msg.type) {
      case 'connected':
        this._onConnected(msg);
        break;
      case 'heartbeat_ack':
        // 正常回包，静默处理
        break;
      case 'error':
        console.error(`[clawd] 服务器错误: ${msg.msg}`);
        if (msg.msg === 'hardware_mismatch') {
          // box_id 与库中不符：硬件变更或凭证泄露
          // 清空本地凭证，下次重连走全新注册流程
          console.warn('[clawd] 硬件指纹与服务器不符（硬件变更或凭证泄露），清除本地凭证重新注册...');
          this._cfg.claw_id = null;
          this._cfg.token   = null;
          config.save(this._cfg);
        } else if (msg.msg && msg.msg.includes('invalid')) {
          console.warn('[clawd] 凭证无效，清除本地凭证并重新注册...');
          this._cfg.claw_id = null;
          this._cfg.token   = null;
          config.save(this._cfg);
        }
        break;
      default:
        console.warn('[clawd] 未知消息类型:', msg.type);
    }
  }

  _onConnected(msg) {
    const isNew = !this._cfg.claw_id;

    // 保存 claw_id + token
    this._cfg.claw_id = msg.claw_id;
    this._cfg.token   = msg.token;
    config.save(this._cfg);

    if (isNew) {
      console.log(`[clawd] 注册成功！claw_id = ${msg.claw_id}`);
    }

    if (msg.status === 'inactive') {
      const id  = String(msg.claw_id).padEnd(6);
      const pin = String(msg.pin);
      console.log('');
      console.log('╔════════════════════════════════════╗');
      console.log(`║  Claw ID : ${id}                  ║`);
      console.log(`║  PIN 码  : ${pin}                  ║`);
      console.log('║  请在网页前台「添加设备」中输入    ║');
      console.log('╚════════════════════════════════════╝');
      console.log('');
      console.log('[clawd] 等待激活，心跳正常运行...');
    } else {
      console.log(`[clawd] 已激活  claw_id = ${msg.claw_id}`);
    }

    // 开始心跳
    this._startHeartbeat();
  }

  // ── 心跳 ─────────────────────────────────────────────────────────────────

  _startHeartbeat() {
    this._clearHeartbeat();
    const interval = (this._cfg.heartbeat_interval || 30) * 1000;

    // 立即发一次
    this._sendHeartbeat();

    this._hbTimer = setInterval(() => this._sendHeartbeat(), interval);
  }

  async _sendHeartbeat() {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    try {
      const metrics = await collect();
      this._send({
        type:    'heartbeat',
        claw_id: this._cfg.claw_id,
        token:   this._cfg.token,
        metrics,
      });
    } catch (e) {
      console.error('[clawd] 心跳发送失败:', e.message);
    }
  }

  _clearHeartbeat() {
    if (this._hbTimer) {
      clearInterval(this._hbTimer);
      this._hbTimer = null;
    }
  }

  // ── 工具 ──────────────────────────────────────────────────────────────────

  _send(obj) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(obj));
    }
  }
}

module.exports = { ClawClient };
