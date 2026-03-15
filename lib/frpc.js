'use strict';

const { execSync, spawn } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const https = require('https');

// frpc 配置目录（与 clawd config 同目录）
const CONFIG_DIR  = process.env.CLAWD_CONFIG_DIR
  || (process.getuid && process.getuid() === 0 ? '/etc/clawd' : path.join(os.homedir(), '.clawd'));
const FRPC_BIN    = path.join(CONFIG_DIR, 'frpc');
const FRPC_CONFIG = path.join(CONFIG_DIR, 'frpc.toml');
const TTYD_BIN    = path.join(CONFIG_DIR, 'ttyd');

// frp / ttyd 版本
const FRP_VERSION  = '0.62.0';
const TTYD_VERSION = '1.7.7';
const TTYD_PORT    = 7681;

/**
 * 启动 openclaw dashboard（后台运行），轮询日志文件等待 Dashboard URL 出现，
 * 解析并返回 { dashboard_token, dashboard_port }。
 * 超时（10s）或命令不存在时返回 {}。
 */
function getDashboardInfo() {
  return new Promise((resolve) => {
    const tmpLog = '/tmp/clawd-dashboard.log';

    // 后台启动 dashboard，输出重定向到日志文件
    try {
      execSync(`openclaw dashboard > ${tmpLog} 2>&1 &`, { shell: true, timeout: 3000 });
    } catch (e) {
      // 已在运行或命令不存在，继续轮询
    }

    // 每秒读一次日志文件，最多等 10 秒
    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      try {
        const content = fs.readFileSync(tmpLog, 'utf8');
        const match = content.match(/Dashboard URL:.*:(\d+)\/#token=([a-f0-9]+)/);
        if (match) {
          clearInterval(interval);
          const port  = parseInt(match[1], 10);
          const token = match[2];
          console.log(`[frpc] openclaw dashboard: port=${port}, token=${token.substring(0, 8)}...`);
          resolve({ dashboard_port: port, dashboard_token: token });
          return;
        }
      } catch (e) { /* 文件暂时不存在 */ }

      if (attempts >= 10) {
        clearInterval(interval);
        resolve({});
      }
    }, 1000);
  });
}

/**
 * 根据当前系统架构下载对应的 frpc 二进制。
 */
async function downloadFrpc() {
  const arch = os.arch();   // 'x64', 'arm64', 'arm', ...
  const platform = os.platform(); // 'linux'

  const archMap = {
    x64: 'amd64', arm64: 'arm64',
    arm: 'arm', ia32: '386',
  };
  const frpArch = archMap[arch] || 'amd64';

  const filename = `frp_${FRP_VERSION}_${platform}_${frpArch}.tar.gz`;
  const url = `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${filename}`;
  const tmpFile = `/tmp/${filename}`;

  console.log(`[frpc] 下载 frpc ${FRP_VERSION} (${platform}/${frpArch})...`);

  await downloadFile(url, tmpFile);

  // 解压并复制 frpc
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  execSync(`tar -xzf ${tmpFile} -C /tmp && cp /tmp/frp_${FRP_VERSION}_${platform}_${frpArch}/frpc ${FRPC_BIN}`, {
    stdio: 'inherit'
  });
  fs.chmodSync(FRPC_BIN, 0o755);
  console.log(`[frpc] frpc 已安装到 ${FRPC_BIN}`);
}

/**
 * 下载 ttyd 静态二进制。
 */
async function downloadTtyd() {
  const arch = os.arch();
  const archMap = { arm64: 'aarch64', x64: 'x86_64', arm: 'armv7l', ia32: 'i686' };
  const ttydArch = archMap[arch] || 'x86_64';
  const url = `https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${ttydArch}`;

  console.log(`[ttyd] 下载 ttyd ${TTYD_VERSION} (${ttydArch})...`);
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  await downloadFile(url, TTYD_BIN);
  fs.chmodSync(TTYD_BIN, 0o755);
  console.log(`[ttyd] ttyd 已安装到 ${TTYD_BIN}`);
}

/**
 * 启动 ttyd（如未安装先下载）。
 * ttyd 绑定 127.0.0.1:7681，供 frpc 代理。
 * 返回 true 表示启动成功，false 表示失败。
 */
async function startTtyd() {
  if (!fs.existsSync(TTYD_BIN)) {
    try {
      await downloadTtyd();
    } catch (e) {
      console.warn('[ttyd] 下载失败:', e.message);
      return false;
    }
  }

  // 终止旧进程（重启 clawd 时可能残留）
  try {
    execSync(`pkill -f "${TTYD_BIN}"`, { timeout: 3000 });
    // 稍等旧进程退出
    await new Promise(r => setTimeout(r, 500));
  } catch (_) { /* 无进程可杀，忽略 */ }

  try {
    const shell = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
    const proc = spawn(TTYD_BIN, ['-p', String(TTYD_PORT), shell], {
      stdio: 'ignore',
      detached: true,
    });
    proc.unref();
    console.log(`[ttyd] 已启动，端口 ${TTYD_PORT}，shell=${shell}`);
    return true;
  } catch (e) {
    console.warn('[ttyd] 启动失败:', e.message);
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

/**
 * 生成 frpc.toml 配置文件。
 * 包含两条代理：
 *   - dashboard-{clawId}  →  openclaw dashboard
 *   - tty-{clawId}        →  ttyd 终端
 */
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
  console.log(`[frpc] frpc.toml 已写入: dashboard subdomain=${clawId}, tty tcp-port=${ttyRemotePort}`);
}

class FrpcManager {
  constructor() {
    this._proc = null;
    this._stopped = false;
    this._restartTimer = null;
  }

  /**
   * 启动 frpc：如未安装先下载，写配置，然后 spawn。
   */
  async start(clawId, frpConfig) {
    this._stopped = false;

    // 下载 frpc（如果不存在）
    if (!fs.existsSync(FRPC_BIN)) {
      try {
        await downloadFrpc();
      } catch (e) {
        console.error('[frpc] 下载 frpc 失败:', e.message);
        return;
      }
    }

    writeFrpcConfig(clawId, frpConfig);
    this._spawn();
  }

  _spawn() {
    if (this._stopped) return;

    console.log('[frpc] 启动 frpc...');
    this._proc = spawn(FRPC_BIN, ['-c', FRPC_CONFIG], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this._proc.stdout.on('data', d => {
      const line = d.toString().trim();
      if (line) console.log(`[frpc] ${line}`);
    });
    this._proc.stderr.on('data', d => {
      const line = d.toString().trim();
      if (line) console.warn(`[frpc] ${line}`);
    });
    this._proc.on('exit', (code) => {
      console.warn(`[frpc] 进程退出 (code=${code})`);
      if (!this._stopped) {
        this._restartTimer = setTimeout(() => this._spawn(), 5000);
      }
    });
  }

  stop() {
    this._stopped = true;
    if (this._restartTimer) clearTimeout(this._restartTimer);
    if (this._proc) {
      this._proc.kill('SIGTERM');
      this._proc = null;
    }
  }
}

module.exports = { getDashboardInfo, startTtyd, FrpcManager };
