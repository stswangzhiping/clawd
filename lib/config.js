'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// 生产环境用 /etc/clawd/，开发环境用 ~/.clawd/
const CONFIG_DIR  = process.env.CLAWD_CONFIG_DIR
  || (process.getuid && process.getuid() === 0
      ? '/etc/clawd'
      : path.join(os.homedir(), '.clawd'));

const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULTS = {
  server:             'wss://claw.cutos.ai/ws',
  claw_id:            null,
  token:              null,
  heartbeat_interval: 30,   // 秒
};

function load() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
      return Object.assign({}, DEFAULTS, JSON.parse(raw));
    }
  } catch (e) {
    const log = require('./logger');
    log.error('config', '读取配置失败，使用默认值:', e.message);
  }
  return Object.assign({}, DEFAULTS);
}

function save(data) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    const log = require('./logger');
    log.error('config', '写入配置失败:', e.message);
  }
}

function getConfigPath() {
  return CONFIG_FILE;
}

module.exports = { load, save, getConfigPath };
