'use strict';

const { execSync, spawn } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const https = require('https');
const log  = require('./logger');
const { Watchdog } = require('./watchdog');

const CONFIG_DIR  = process.env.CLAWD_CONFIG_DIR
  || (process.getuid && process.getuid() === 0 ? '/etc/clawd' : path.join(os.homedir(), '.clawd'));
const FRPC_BIN    = path.join(CONFIG_DIR, 'frpc');
const FRPC_CONFIG = path.join(CONFIG_DIR, 'frpc.toml');
const TTYD_BIN    = path.join(CONFIG_DIR, 'ttyd');

const FRP_VERSION  = '0.62.0';
const TTYD_VERSION = '1.7.7';
const TTYD_PORT    = 7681;

/**
 * 从 openclaw 配置文件中提取 dashboard token 和端口。
 * openclaw 将 gateway token 持久化存储在 ~/.openclaw/openclaw.json 中，
 * 直接读取比执行命令更可靠（不依赖 PATH、不需要进程启动等待）。
 * systemd 服务的 ProtectHome=read-only 允许读取 /home 下的文件。
 */
function getDashboardInfo() {
  const configCandidates = [
    path.join(os.homedir(), '.openclaw', 'openclaw.json'),
    '/home/sts/.openclaw/openclaw.json',
    '/root/.openclaw/openclaw.json',
  ];

  for (const cfgPath of configCandidates) {
    try {
      const raw    = fs.readFileSync(cfgPath, 'utf8');
      const config = JSON.parse(raw);
      const token  = config?.gateway?.auth?.token;
      const port   = config?.gateway?.port || 18789;
      if (token) {
        log.info('dashboard', `从配置文件读取: port=${port}, token=${token.substring(0, 8)}...`);
        return Promise.resolve({ dashboard_port: port, dashboard_token: token });
      }
    } catch (_) { /* 文件不存在或格式错误，尝试下一个路径 */ }
  }

  log.debug('dashboard', 'openclaw 配置文件未找到或无 token，跳过 dashboard 信息获取');
  return Promise.resolve({});
}

async function downloadFrpc() {
  const arch = os.arch();
  const platform = os.platform();

  const archMap = {
    x64: 'amd64', arm64: 'arm64',
    arm: 'arm', ia32: '386',
  };
  const frpArch = archMap[arch] || 'amd64';

  const filename = `frp_${FRP_VERSION}_${platform}_${frpArch}.tar.gz`;
  const url = `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${filename}`;
  const tmpFile = `/tmp/${filename}`;

  log.info('frpc', `下载 frpc ${FRP_VERSION} (${platform}/${frpArch})...`);

  await downloadFile(url, tmpFile);

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  execSync(`tar -xzf ${tmpFile} -C /tmp && cp /tmp/frp_${FRP_VERSION}_${platform}_${frpArch}/frpc ${FRPC_BIN}`, {
    stdio: 'inherit'
  });
  fs.chmodSync(FRPC_BIN, 0o755);
  log.info('frpc', `frpc 已安装到 ${FRPC_BIN}`);
}

async function downloadTtyd() {
  const arch = os.arch();
  const archMap = { arm64: 'aarch64', x64: 'x86_64', arm: 'armv7l', ia32: 'i686' };
  const ttydArch = archMap[arch] || 'x86_64';
  const url = `https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${ttydArch}`;

  log.info('ttyd', `下载 ttyd ${TTYD_VERSION} (${ttydArch})...`);
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  await downloadFile(url, TTYD_BIN);
  fs.chmodSync(TTYD_BIN, 0o755);
  log.info('ttyd', `ttyd 已安装到 ${TTYD_BIN}`);
}

/**
 * 启动 ttyd（如未安装先下载）。
 * ttyd 绑定 127.0.0.1:7681，供 frpc 代理。
 */
async function startTtyd() {
  if (!fs.existsSync(TTYD_BIN)) {
    try {
      await downloadTtyd();
    } catch (e) {
      log.warn('ttyd', '下载失败:', e.message);
      return false;
    }
  }

  // 终止旧进程
  try {
    execSync(`pkill -f "${TTYD_BIN}"`, { timeout: 3000 });
    await new Promise(r => setTimeout(r, 500));
  } catch (_) {}

  try {
    const shell = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
    // 以普通用户身份启动 shell（与 SSH 登录一致）
    const ttydUser = process.env.CLAWD_TTY_USER || 'sts';
    const proc = spawn(TTYD_BIN, ['-p', String(TTYD_PORT), '-i', '127.0.0.1', '-W', '-t', 'cursorBlink=true', '/bin/su', '-', ttydUser], {
      stdio: 'ignore',
      detached: true,
    });
    proc.unref();
    log.info('ttyd', `已启动，端口 ${TTYD_PORT}，用户=${ttydUser}`);
    return true;
  } catch (e) {
    log.warn('ttyd', '启动失败:', e.message);
    return false;
  }
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close();
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (e) => { fs.unlink(dest, () => {}); reject(e); });
  });
}

function writeFrpcConfig(clawId, frpConfig) {
  const { server, port, auth_token, dashboard_local_port = 18789 } = frpConfig;
  const ttyRemotePort = 10000 + Number(clawId);
  const toml = `# 由 clawd 自动生成，请勿手动修改
serverAddr = "${server}"
serverPort = ${port}

[auth]
method = "token"
token = "${auth_token}"

[[proxies]]
name = "dashboard-${clawId}"
type = "http"
localPort = ${dashboard_local_port}
subdomain = "${clawId}"

[[proxies]]
name = "tty-${clawId}"
type = "tcp"
localPort = ${TTYD_PORT}
remotePort = ${ttyRemotePort}
`;
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(FRPC_CONFIG, toml, 'utf8');
  log.info('frpc', `frpc.toml 已写入: dashboard subdomain=${clawId}, tty tcp-port=${ttyRemotePort}`);
}

/**
 * FrpcManager —— 基于 Watchdog 的 frpc 进程管理器。
 * 崩溃自动重启，5 分钟内最多重启 10 次。
 */
class FrpcManager {
  constructor() {
    this._watchdog = null;
  }

  async start(clawId, frpConfig) {
    this.stop();

    if (!fs.existsSync(FRPC_BIN)) {
      try {
        await downloadFrpc();
      } catch (e) {
        log.error('frpc', '下载 frpc 失败:', e.message);
        return;
      }
    }

    writeFrpcConfig(clawId, frpConfig);

    this._watchdog = new Watchdog('frpc', FRPC_BIN, ['-c', FRPC_CONFIG], {
      maxRestarts:  10,
      windowMs:     300_000,
      restartDelay: 5_000,
    });
    this._watchdog.start();
  }

  stop() {
    if (this._watchdog) {
      this._watchdog.stop();
      this._watchdog = null;
    }
  }
}

module.exports = { getDashboardInfo, startTtyd, FrpcManager };
