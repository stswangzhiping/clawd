'use strict';

const { spawn }  = require('child_process');
const log        = require('./logger');

const DEFAULT_MAX_RESTARTS  = 10;
const DEFAULT_WINDOW_MS     = 300_000; // 5 min
const DEFAULT_RESTART_DELAY = 3_000;

/**
 * 通用子进程守护：崩溃自动重启、速率限制、健康回调。
 *
 * 用法：
 *   const wd = new Watchdog('frpc', '/path/to/frpc', ['-c', 'frpc.toml'], {
 *     maxRestarts: 10,
 *     windowMs:    300_000,
 *     onStdout: (line) => { ... },
 *   });
 *   wd.start();
 *   wd.stop();
 */
class Watchdog {
  constructor(name, bin, args = [], opts = {}) {
    this._name          = name;
    this._bin           = bin;
    this._args          = args;
    this._proc          = null;
    this._stopped       = false;
    this._restartTimer  = null;
    this._onStdout      = opts.onStdout  || null;
    this._onStderr      = opts.onStderr  || null;
    this._onExit        = opts.onExit    || null;
    this._spawnOpts     = opts.spawnOpts || {};

    this._maxRestarts   = opts.maxRestarts  ?? DEFAULT_MAX_RESTARTS;
    this._windowMs      = opts.windowMs     ?? DEFAULT_WINDOW_MS;
    this._restartDelay  = opts.restartDelay ?? DEFAULT_RESTART_DELAY;

    this._restartTimes  = []; // timestamps of recent restarts
  }

  get running() {
    return !!(this._proc && !this._proc.killed);
  }

  start() {
    this._stopped = false;
    this._spawn();
  }

  stop() {
    this._stopped = true;
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    if (this._proc) {
      this._proc.kill('SIGTERM');
      // 强杀兜底
      const p = this._proc;
      setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} }, 5000);
      this._proc = null;
    }
  }

  _spawn() {
    if (this._stopped) return;

    log.info(this._name, '启动进程...');
    const { env: optsEnv, ...restSpawn } = this._spawnOpts;
    const env = { ...process.env, ...optsEnv };
    delete env.NOTIFY_SOCKET; // 避免 frpc 等子进程向 systemd 发 notify，触发非主 PID 拒收
    const proc = spawn(this._bin, this._args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...restSpawn,
      env,
    });
    this._proc = proc;

    proc.stdout.on('data', (d) => {
      const line = d.toString().trim();
      if (!line) return;
      if (this._onStdout) this._onStdout(line);
      else log.info(this._name, line);
    });

    proc.stderr.on('data', (d) => {
      const line = d.toString().trim();
      if (!line) return;
      if (this._onStderr) this._onStderr(line);
      else log.warn(this._name, line);
    });

    proc.on('error', (err) => {
      log.error(this._name, '进程启动失败:', err.message);
    });

    proc.on('exit', (code, signal) => {
      log.warn(this._name, `进程退出 code=${code} signal=${signal}`);
      this._proc = null;
      if (this._onExit) this._onExit(code, signal);
      if (!this._stopped) this._scheduleRestart();
    });
  }

  _scheduleRestart() {
    const now = Date.now();
    this._restartTimes.push(now);

    // 只保留窗口内的记录
    this._restartTimes = this._restartTimes.filter(t => now - t < this._windowMs);

    if (this._restartTimes.length > this._maxRestarts) {
      log.error(this._name,
        `${this._windowMs / 1000}s 内重启 ${this._restartTimes.length} 次，超过上限 ${this._maxRestarts}，停止守护`);
      return;
    }

    const delay = this._restartDelay * Math.min(this._restartTimes.length, 5);
    log.info(this._name, `${delay / 1000}s 后重启... (窗口内第 ${this._restartTimes.length} 次)`);
    this._restartTimer = setTimeout(() => this._spawn(), delay);
  }
}

module.exports = { Watchdog };
