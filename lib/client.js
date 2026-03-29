'use strict';

const fs = require('fs');
const { getNotifySocket } = require('./systemd-env');
const WebSocket = require('ws');
const { execSync, execFileSync } = require('child_process');
const config    = require('./config');
const log       = require('./logger');
const { getBoxId }        = require('./fingerprint');
const { collect }         = require('./metrics');
const { getDashboardInfo, resolveOpenclawConfigFile, startTtyd, FrpcManager } = require('./frpc');  // getDashboardInfo 也用于心跳中定期刷新
const { ProvisionManager } = require('./provisioning');
const { BtMonitor }        = require('./bt-monitor');
const { hasInternet, hasWiredInternetProbe, getLocalIps } = require('./network');
const led = require('./led');

const MAX_BACKOFF_MS      = 60_000;
/** 连续若干轮 ping 后仍无 pong 才判定死链（单轮易因调度/弱网误判） */
const PONG_MISS_MAX       = 3;
const PING_INTERVAL_MS    = 15_000;
const HEARTBEAT_INTERVAL_MS = 10_000; // 心跳间隔：10 秒，用于快速感知网络状态
const METRICS_EVERY_N     = 3;        // 每 N 次心跳采集一次指标（= 30 秒）

/** 内核是否暴露蓝牙适配器（hci*） */
function bluetoothAdapterPresent() {
  try {
    return fs.readdirSync('/sys/class/bluetooth').some((n) => n.startsWith('hci'));
  } catch (_) {
    return false;
  }
}

/** 是否启动 BtMonitor（会周期性执行 bluetoothctl） */
function btMonitorEnabled() {
  const v = (process.env.CLAWD_DISABLE_BT || '').trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes') return false;
  if (!bluetoothAdapterPresent()) return false;
  return true;
}

class ClawClient {
  constructor() {
    this._cfg     = config.load();
    this._boxId   = getBoxId();
    this._ws      = null;
    this._hbTimer = null;
    this._backoff = 1_000;
    this._stopped = false;
    this._frpc       = new FrpcManager();
    this._btMonitor  = null;
    this._dashInfo   = {};
    this._hbCount  = 0;    // 心跳计数器，用于定期刷新 dashboard 信息
    this._externalIp = null;  // 外网 IP
    this._location   = null;  // 地理位置（由 ipplus360 返回，如"北京市-北京市西城区"）

    // WS 层活性检测
    this._pingTimer       = null;
    this._awaitingPong    = false;
    this._pongMissCount   = 0;

    // WS 连续失败计数（open 时清零）
    this._wsFailCount = 0;
    // 是否曾经成功连接过（首次成功前不显示 Err0/AP）
    this._hasEverConnected = false;
    // 最近一次 WS 错误是否是证书时间问题（NTP 未同步）
    this._certTimeError = false;


    // systemd watchdog（systemd-notify 子进程 + unit 里 NotifyAccess=all）
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

    // 启动时关 alarm；若本地已记为已激活，立即亮 pwr（不等首包 connected）
    led.status.off();
    if (this._cfg.activated) {
      led.status.setApps();
    }

    this._startSdNotify();

    // RJ45 链路轮询（OpenVFD play），与 WS 无关，进程起来即开始
    led.lan.start();

    // 蓝牙状态监控（bluetoothctl）；CLAWD_DISABLE_BT=1 或无 hci 时不启动
    if (btMonitorEnabled()) {
      this._btMonitor = new BtMonitor();
      this._btMonitor.start();
    } else {
      const dis = (process.env.CLAWD_DISABLE_BT || '').trim().toLowerCase();
      const forced = dis === '1' || dis === 'true' || dis === 'yes';
      log.info(
        'clawd',
        forced
          ? '已跳过蓝牙监控（CLAWD_DISABLE_BT 已开启）'
          : '已跳过蓝牙监控（未检测到 hci 适配器）',
      );
    }

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
      log.info('clawd', '等待外网就绪（可配网；有线已接时将自动识别网卡，含非 eth0 口）...');
    }
  }

  async _proceedWithConnection() {
    const [dashInfo] = await Promise.all([
      getDashboardInfo().catch(e => { log.warn('clawd', 'dashboard 信息获取失败:', e.message); return null; }),
      startTtyd().catch(e => log.warn('ttyd', '启动失败:', e.message)),
    ]);
    this._dashInfo = dashInfo || {};

    // 查询外网 IP 和地理位置，失败不阻断连接
    try {
      const https = require('https');

      const fetchText = (url) => new Promise((resolve) => {
        const req = https.get(url, { timeout: 5000 }, (res) => {
          let body = '';
          res.on('data', d => { body += d; });
          res.on('end', () => resolve(body.trim()));
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
      });

      const fetchJson = (url) => new Promise((resolve) => {
        const req = https.get(url, { timeout: 5000 }, (res) => {
          let body = '';
          res.on('data', d => { body += d; });
          res.on('end', () => {
            try { resolve(JSON.parse(body)); } catch { resolve(null); }
          });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
      });

      // 外网 IP：checkip.amazonaws.com 返回纯文本 IP
      const ip = await fetchText('https://checkip.amazonaws.com');
      if (ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
        this._externalIp = ip;
        log.info('clawd', `外网 IP: ${this._externalIp}`);
      }

      // 地理位置：ipplus360（国内访问）返回 {"success":true,"data":"北京市-北京市西城区"}
      const geoResp = await fetchJson('https://www.ipplus360.com/getLocation');
      if (geoResp && geoResp.success && geoResp.data) {
        this._location = geoResp.data;
        log.info('clawd', `地理位置: ${this._location}`);
      }
    } catch (e) {
      log.warn('clawd', '网络信息查询失败:', e.message);
    }

    this._connect();
  }

  stop() {
    this._stopped = true;
    this._clearHeartbeat();
    this._clearPing();
    if (this._sdTimer) { clearInterval(this._sdTimer); this._sdTimer = null; }
    led.lan.stop();
    if (this._btMonitor)    { this._btMonitor.stop();    this._btMonitor    = null; }
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

    // AP 模式 + 无网：不建立 WS，5s 后重新检查（有线经 -I ping 仍通则建立，避免热点误挡 WS）
    if (this._provisionMgr && this._provisionMgr.isApMode() && !hasInternet() && !hasWiredInternetProbe()) {
      led.display.showAP();
      log.info('clawd', 'AP 模式无网络，5s 后重新检查...');
      this._backoff     = 1_000; // 有网时立即快速重连
      this._wsFailCount = 0;     // 不计入失败
      setTimeout(() => this._connect(), 5_000);
      return;
    }

    if (!this._hasEverConnected || this._wsFailCount < 3) led.display.showConn();
    log.info('clawd', `正在连接 ${this._cfg.server} ...`);
    const ws = new WebSocket(this._cfg.server, {
      handshakeTimeout: 10_000,
    });
    this._ws = ws;

    ws.on('open', () => {
      log.info('clawd', 'WebSocket 已连接');
      this._backoff = 1_000;
      this._wsFailCount = 0;       // 连接成功，重置失败计数
      this._hasEverConnected = true; // 标记已成功连接过
      if (this._cfg.activated) {
        led.status.setApps();
      }
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
      this._pongMissCount = 0;
    });

    ws.on('close', (code, reason) => {
      this._clearHeartbeat();
      this._clearPing();
      if (!this._stopped) {
        this._wsFailCount++;
        log.warn('clawd', `连接断开 (${code})，失败次数=${this._wsFailCount}，${this._backoff / 1000}s 后重连...`);
        if (this._hasEverConnected && this._wsFailCount >= 3) {
          const inAp = this._provisionMgr && this._provisionMgr.isApMode();
          if (inAp || (!hasInternet() && !hasWiredInternetProbe())) {
            led.display.showAP();   // AP 模式 或 无网（有线探测也无则视为无上行）
          } else {
            led.display.showErr0(); // STA 模式 + 有网 但 VPS 不可达
          }
        }
        if (this._certTimeError) {
          // NTP 未同步：固定 5s 重试，等时钟校正
          this._certTimeError = false;
          this._backoff = 5_000;
          log.warn('clawd', '证书时间错误（NTP 未同步），5s 后重试...');
        } else {
          this._backoff = Math.min(this._backoff * 2, MAX_BACKOFF_MS);
        }
        setTimeout(() => this._connect(), this._backoff);
      }
    });

    ws.on('error', (err) => {
      log.error('clawd', '连接错误:', err.message);
      // 证书时间错误：NTP 未同步，close 后用固定短间隔重试，不做指数退避
      this._certTimeError = !!(
        err.code === 'CERT_NOT_YET_VALID' ||
        (err.message && err.message.includes('not yet valid'))
      );
    });
  }

  // ── WS 层 Ping/Pong 活性检测 ──────────────────────────────────────────────

  _startPing() {
    this._clearPing();
    this._pingTimer = setInterval(() => {
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;

      if (this._awaitingPong) {
        this._pongMissCount++;
        if (this._pongMissCount >= PONG_MISS_MAX) {
          log.warn('clawd', `Pong 连续 ${PONG_MISS_MAX} 次未响应，主动关闭重连`);
          this._ws.terminate();
          return;
        }
        log.warn('clawd', `Pong 超时 (${this._pongMissCount}/${PONG_MISS_MAX})，继续探测...`);
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
    this._pongMissCount = 0;
  }

  // ── 发送 connect ─────────────────────────────────────────────────────────────

  _sendConnect() {
    const msg = {
      type:        'connect',
      box_id:      this._boxId,
      claw_id:     this._cfg.claw_id  ?? null,
      token:       this._cfg.token    ?? null,
      local_ip:    getLocalIps(),
      external_ip: this._externalIp ?? null,
      location:    this._location   ?? null,
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
      case 'status_update':
        this._applyStatus(msg);
        break;
      case 'error':
        log.error('clawd', `服务器错误: ${msg.msg}`);
        if (msg.msg === 'hardware_mismatch') {
          log.warn('clawd', '硬件指纹不符，清除凭证重新注册...');
          this._cfg.claw_id = null;
          this._cfg.token   = null;
          this._cfg.activated = false;
          config.save(this._cfg);
          led.status.setSetup();
        } else if (msg.msg && msg.msg.includes('invalid')) {
          log.warn('clawd', '凭证无效，清除凭证重新注册...');
          this._cfg.claw_id = null;
          this._cfg.token   = null;
          this._cfg.activated = false;
          config.save(this._cfg);
          led.status.setSetup();
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

    this._applyStatus(msg);

    if (msg.frp && msg.frp.server && msg.frp.auth_token) {
      this._frpc.start(msg.claw_id, msg.frp).catch(e => {
        log.error('frpc', '启动失败:', e.message);
      });
    }

    this._startHeartbeat();
  }

  _applyStatus(msg) {
    if (msg.status === 'inactive') {
      this._cfg.activated = false;
      config.save(this._cfg);
      led.status.setSetup();
      led.display.showPin(msg.pin);
      const id  = String(this._cfg.claw_id || '').padEnd(6);
      const pin = String(msg.pin || '');
      log.info('clawd', '');
      log.info('clawd', '╔════════════════════════════════════╗');
      log.info('clawd', `║  Claw ID : ${id}                  ║`);
      log.info('clawd', `║  PIN 码  : ${pin}                  ║`);
      log.info('clawd', '║  请在网页前台「添加设备」中输入    ║');
      log.info('clawd', '╚════════════════════════════════════╝');
      log.info('clawd', '');
      log.info('clawd', '等待激活，心跳正常运行...');
      this._updateOpenClawOrigin('0000');
    } else {
      this._cfg.activated = true;
      config.save(this._cfg);
      led.status.setApps();
      led.display.showTime();
      log.info('clawd', `已激活  claw_id = ${this._cfg.claw_id}`);
      this._updateOpenClawOrigin(String(this._cfg.claw_id));
    }
  }

  // ── OpenClaw 配置 ────────────────────────────────────────────────────────────

  _updateOpenClawOrigin(targetId) {
    const { readFileSync, writeFileSync } = require('fs');
    const configFile = resolveOpenclawConfigFile();

    if (!configFile) {
      log.warn('clawd', 'openclaw 配置文件不存在（~/.openclaw/openclaw.json 等候选路径均未找到）');
      return;
    }

    try {
      const raw = readFileSync(configFile, 'utf8');
      const config = JSON.parse(raw);
      const newOrigin = `https://${targetId}.claw.cutos.ai`;
      const re = /https:\/\/[^"'\s]+\.claw\.cutos\.ai/g;

      /** 与原 YAML 全文替换等价：遍历 JSON 内所有字符串并替换匹配的 origin */
      const replaceOriginStrings = (node) => {
        let changed = false;
        if (typeof node === 'string') {
          return false;
        }
        if (Array.isArray(node)) {
          for (let i = 0; i < node.length; i++) {
            const v = node[i];
            if (typeof v === 'string') {
              const next = v.replace(re, newOrigin);
              if (next !== v) {
                node[i] = next;
                changed = true;
              }
            } else if (v && typeof v === 'object') {
              changed = replaceOriginStrings(v) || changed;
            }
          }
          return changed;
        }
        if (node && typeof node === 'object') {
          for (const k of Object.keys(node)) {
            const v = node[k];
            if (typeof v === 'string') {
              const next = v.replace(re, newOrigin);
              if (next !== v) {
                node[k] = next;
                changed = true;
              }
            } else if (v && typeof v === 'object') {
              changed = replaceOriginStrings(v) || changed;
            }
          }
          return changed;
        }
        return false;
      };

      if (!replaceOriginStrings(config)) {
        log.info('clawd', `openclaw origin 已是 ${newOrigin}，无需变更`);
        return;
      }

      writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
      log.info('clawd', `openclaw config 已更新: ${newOrigin}`);

      // 文件有变化，kill -9 openclaw-gateway，让它被 systemd --user 自动拉起
      try {
        execSync('pkill -9 -x openclaw-gateway', { timeout: 3000 });
        log.info('clawd', 'openclaw-gateway 已终止，等待自动重启');
      } catch (_) {
        // pkill 找不到进程时返回非 0，属于正常情况（进程未运行）
        log.info('clawd', 'openclaw-gateway 进程不存在，无需终止');
      }
    } catch (e) {
      log.warn('clawd', `openclaw config 更新失败: ${e.message}`);
    }
  }

  // ── 心跳 ────────────────────────────────────────────────────────────────────

  _startHeartbeat() {
    this._clearHeartbeat();
    this._sendHeartbeat();
    this._hbTimer = setInterval(() => this._sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
  }

  async _sendHeartbeat() {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    try {
      this._hbCount++;

      // 每 30 次心跳（约 5 分钟）刷新一次 dashboard 信息
      if (this._hbCount % 30 === 0) {
        const freshInfo = await getDashboardInfo().catch(() => null);
        if (freshInfo && Object.keys(freshInfo).length > 0) {
          this._dashInfo = freshInfo;
        }
      }

      // 每 METRICS_EVERY_N 次心跳（30 秒）采集一次指标，其余发轻量心跳
      const msg = {
        type:    'heartbeat',
        claw_id: this._cfg.claw_id,
        token:   this._cfg.token,
        ...this._dashInfo,
      };
      if (this._hbCount % METRICS_EVERY_N === 0) {
        msg.metrics = await collect();
      }
      this._send(msg);
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
    const raw = getNotifySocket();
    if (!raw) return;

    // 部分嵌入式 systemd 有 WatchdogSec 但未注入 WATCHDOG_USEC；若此时不喂狗，约 1min 会 SIGABRT
    let usec = parseInt(process.env.WATCHDOG_USEC || '0', 10);
    if (usec <= 0) {
      usec = 60_000_000;
      log.info('clawd', 'WATCHDOG_USEC 未设置，按 60s 周期向 systemd 发送 WATCHDOG=1（与 unit WatchdogSec=60 一致）');
    }
    const intervalMs = Math.max(1000, Math.floor(usec / 2 / 1000));

    log.debug('clawd', `systemd watchdog 启用，通知间隔 ${intervalMs}ms`);
    this._sdNotify('READY=1');
    this._sdTimer = setInterval(() => this._sdNotify('WATCHDOG=1'), intervalMs);
  }

  /**
   * 通过 systemd-notify 写入 NOTIFY_SOCKET。嵌入式上 Node unix_dgram 对抽象套接字常无效；
   * 子进程发 notify 需在 unit 中设置 NotifyAccess=all（install.sh 已写）。
   */
  _sdNotify(msg) {
    const sock = getNotifySocket();
    if (!sock) return;
    const arg = String(msg).replace(/\n+$/, '');
    if (!arg) return;
    try {
      execFileSync('systemd-notify', [arg], {
        timeout: 3000,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH || '/usr/bin:/bin',
          NOTIFY_SOCKET: sock,
        },
      });
    } catch (e) {
      log.warn('clawd', 'systemd-notify 失败:', e.message);
    }
  }
}

module.exports = { ClawClient };
