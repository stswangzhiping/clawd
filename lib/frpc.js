'use strict';

const { execSync, spawn, execFileSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const https = require('https');

// frpc 配置目录（与 clawd config 同目录）
const CONFIG_DIR  = process.env.CLAWD_CONFIG_DIR
  || (process.getuid && process.getuid() === 0 ? '/etc/clawd' : path.join(os.homedir(), '.clawd'));
const FRPC_BIN    = path.join(CONFIG_DIR, 'frpc');
const FRPC_CONFIG = path.join(CONFIG_DIR, 'frpc.toml');

// frp 版本
const FRP_VERSION = '0.62.0';

/**
 * 提取 openclaw dashboard 的访问 token 和端口。
 * 执行 `openclaw dashboard`，从输出中解析 Dashboard URL。
 * 返回 { dashboard_token, dashboard_port } 或 {}（命令不存在/失败时）。
 */
function getDashboardInfo() {
  try {
    const out = execSync(
      `openclaw dashboard 2>&1 | grep 'Dashboard URL' | sed -E 's|.*:([0-9]+)/.*#token=([a-f0-9]+).*|\\1 \\2|'`,
      { timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).toString().trim();

    if (!out) return {};
    const [portStr, token] = out.split(' ');
    const port = parseInt(portStr, 10);
    if (!token || isNaN(port)) return {};

    console.log(`[frpc] openclaw dashboard: port=${port}, token=${token.substring(0, 8)}...`);
    return { dashboard_port: port, dashboard_token: token };
  } catch (e) {
    // openclaw 未安装或命令失败，跳过
    return {};
  }
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
 */
function writeFrpcConfig(clawId, frpConfig) {
  const { server, port, auth_token, dashboard_local_port = 18789 } = frpConfig;
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
`;
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(FRPC_CONFIG, toml, 'utf8');
  console.log(`[frpc] frpc.toml 已写入: subdomain=${clawId}, localPort=${dashboard_local_port}`);
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

module.exports = { getDashboardInfo, FrpcManager };
