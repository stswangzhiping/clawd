'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

const CONFIG_DIR = process.env.CLAWD_CONFIG_DIR
  || (process.getuid && process.getuid() === 0 ? '/etc/clawd' : path.join(os.homedir(), '.clawd'));

const LOG_DIR       = process.env.CLAWD_LOG_DIR || path.join(CONFIG_DIR, 'logs');
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_FILES     = 5;

class Logger {
  constructor(opts = {}) {
    this._level     = LEVELS[opts.level || process.env.CLAWD_LOG_LEVEL || 'info'] ?? LEVELS.info;
    this._logToFile = opts.logToFile ?? (process.env.CLAWD_LOG_FILE !== '0');
    this._stream    = null;
    this._filePath  = null;
    this._fileSize  = 0;

    if (this._logToFile) {
      this._ensureLogDir();
    }
  }

  debug(tag, ...args) { this._log('debug', tag, args); }
  info(tag, ...args)  { this._log('info',  tag, args); }
  warn(tag, ...args)  { this._log('warn',  tag, args); }
  error(tag, ...args) { this._log('error', tag, args); }

  _log(level, tag, args) {
    if (LEVELS[level] < this._level) return;

    const ts   = new Date().toISOString();
    const lvl  = level.toUpperCase().padEnd(5);
    const body = args.map(a => (a instanceof Error ? a.stack || a.message : String(a))).join(' ');
    const line = `${ts} ${lvl} [${tag}] ${body}`;

    const consoleFn = level === 'error' ? console.error
      : level === 'warn' ? console.warn
      : console.log;
    consoleFn(line);

    if (this._logToFile) this._writeToFile(line + '\n');
  }

  _ensureLogDir() {
    try { fs.mkdirSync(LOG_DIR, { recursive: true }); }
    catch (_) { this._logToFile = false; }
  }

  _writeToFile(line) {
    if (!this._stream) this._openFile();
    if (!this._stream) return;

    this._stream.write(line);
    this._fileSize += Buffer.byteLength(line);

    if (this._fileSize >= MAX_FILE_SIZE) this._rotate();
  }

  _openFile() {
    try {
      this._filePath = path.join(LOG_DIR, 'clawd.log');
      try {
        const stat = fs.statSync(this._filePath);
        this._fileSize = stat.size;
      } catch (_) { this._fileSize = 0; }

      this._stream = fs.createWriteStream(this._filePath, { flags: 'a' });
      this._stream.on('error', () => {
        this._logToFile = false;
        this._stream = null;
      });
    } catch (_) {
      this._logToFile = false;
    }
  }

  _rotate() {
    if (this._stream) {
      this._stream.end();
      this._stream = null;
    }

    // clawd.log.4 → delete, clawd.log.3 → .4, ... clawd.log → .1
    for (let i = MAX_FILES - 1; i >= 1; i--) {
      const from = path.join(LOG_DIR, `clawd.log.${i}`);
      const to   = path.join(LOG_DIR, `clawd.log.${i + 1}`);
      try { fs.renameSync(from, to); } catch (_) {}
    }
    try {
      fs.renameSync(this._filePath, path.join(LOG_DIR, 'clawd.log.1'));
    } catch (_) {}

    // 删除超出上限的文件
    try {
      fs.unlinkSync(path.join(LOG_DIR, `clawd.log.${MAX_FILES + 1}`));
    } catch (_) {}

    this._fileSize = 0;
    this._openFile();
  }

  close() {
    if (this._stream) {
      this._stream.end();
      this._stream = null;
    }
  }
}

const logger = new Logger();

module.exports = logger;
