'use strict';

const http = require('http');
const log  = require('./logger');
const { scanWifi, connectWifi } = require('./network');
const { CAPTIVE_DOMAIN } = require('./dns-hijack');

const PORT = 80;

// iOS / Android / Windows Captive Portal 检测路径
const CAPTIVE_DETECT_PATHS = new Set([
  '/hotspot-detect.html',       // iOS
  '/library/test/success.html', // iOS older
  '/generate_204',              // Android
  '/gen_204',                   // Android alt
  '/connecttest.txt',           // Windows
  '/ncsi.txt',                  // Windows alt
  '/redirect',                  // Windows 11
  '/canonical.html',            // Firefox
]);

/**
 * 配网 HTTP 服务器。
 *
 * 路由：
 *   GET  /             → 配网页面（HTML）
 *   GET  /api/scan     → WiFi 扫描结果 JSON
 *   POST /api/connect  → 提交 WiFi 凭证，尝试连接
 *   GET  /api/status   → 当前连接状态
 *   Captive Portal 检测 → 302 重定向到配网页
 */
class CaptiveServer {
  constructor(opts = {}) {
    this._server  = null;
    this._clawId  = opts.clawId || '???';
    this._resolve = null; // provisioning 等待配网完成的 resolve
  }

  /**
   * 启动 HTTP 服务器，返回 Promise，配网成功后 resolve。
   */
  start() {
    return new Promise((resolve) => {
      this._resolve = resolve;

      this._server = http.createServer((req, res) => {
        this._handle(req, res).catch(e => {
          log.error('http', `${req.method} ${req.url} 异常:`, e.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '内部错误' }));
        });
      });

      this._server.listen(PORT, '0.0.0.0', () => {
        log.info('http', `配网页面就绪: http://${CAPTIVE_DOMAIN} (端口 ${PORT})`);
      });

      this._server.on('error', (e) => {
        if (e.code === 'EACCES') {
          log.error('http', `端口 ${PORT} 无权限，请以 root 运行或改用高端口`);
        } else {
          log.error('http', '服务器错误:', e.message);
        }
      });
    });
  }

  stop() {
    if (this._server) {
      this._server.close();
      this._server = null;
    }
  }

  async _handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // Captive Portal 检测请求 → 302 到配网页
    if (CAPTIVE_DETECT_PATHS.has(pathname)) {
      res.writeHead(302, { Location: `http://${CAPTIVE_DOMAIN}/` });
      res.end();
      return;
    }

    // API 路由
    if (pathname === '/api/scan' && req.method === 'GET') {
      return this._apiScan(req, res);
    }
    if (pathname === '/api/connect' && req.method === 'POST') {
      return this._apiConnect(req, res);
    }
    if (pathname === '/api/status' && req.method === 'GET') {
      return this._apiStatus(req, res);
    }

    // 默认返回配网页面
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(this._renderPage());
  }

  // ── API ──────────────────────────────────────────────────────────────────

  _apiScan(req, res) {
    const list = scanWifi();
    this._json(res, { wifi: list });
  }

  async _apiConnect(req, res) {
    const body = await readBody(req);
    let data;
    try { data = JSON.parse(body); } catch (_) {
      this._json(res, { success: false, error: 'JSON 格式错误' }, 400);
      return;
    }

    const { ssid, password } = data;
    if (!ssid) {
      this._json(res, { success: false, error: '请选择 WiFi' }, 400);
      return;
    }

    log.info('http', `用户提交配网: ssid=${ssid}`);

    // 先返回 "尝试中" 让前端轮询 /api/status
    this._json(res, { success: true, message: '正在连接...' });

    // 异步连接 WiFi（会关闭 AP，客户端会断开）
    setTimeout(async () => {
      const result = connectWifi(ssid, password || '');
      if (result.success && this._resolve) {
        log.info('http', '配网成功，退出配网模式');
        this._resolve({ ssid });
        this._resolve = null;
      } else {
        log.warn('http', `配网失败: ${result.error}，重新启动 AP`);
        // provisioning.js 会处理重新进入 AP
      }
    }, 500);
  }

  _apiStatus(req, res) {
    const { hasInternet } = require('./network');
    this._json(res, { connected: hasInternet() });
  }

  _json(res, data, code = 200) {
    res.writeHead(code, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(data));
  }

  // ── 配网页面 HTML ───────────────────────────────────────────────────────

  _renderPage() {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Claw Box 配网</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f0f2f5;color:#333;min-height:100vh;display:flex;justify-content:center;align-items:center;padding:20px}
.card{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.1);padding:32px;width:100%;max-width:380px}
.logo{text-align:center;margin-bottom:24px}
.logo span{font-size:40px}
.logo h1{font-size:20px;margin-top:8px;color:#1a1a2e}
.logo p{font-size:13px;color:#888;margin-top:4px}
.device-id{text-align:center;background:#f8f9fa;border-radius:8px;padding:8px;margin-bottom:20px;font-size:14px;color:#555}
.device-id strong{color:#1a1a2e;font-size:16px}
label{display:block;font-size:14px;font-weight:500;margin-bottom:6px;color:#555}
select,input{width:100%;padding:12px;border:1.5px solid #ddd;border-radius:8px;font-size:15px;outline:none;transition:border-color .2s}
select:focus,input:focus{border-color:#4a6cf7}
.field{margin-bottom:16px}
.btn{width:100%;padding:14px;background:linear-gradient(135deg,#4a6cf7,#3b5de7);color:#fff;border:none;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;transition:opacity .2s}
.btn:hover{opacity:.9}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn-scan{background:#f0f2f5;color:#555;font-size:13px;padding:8px;margin-bottom:16px;font-weight:400}
.btn-scan:hover{background:#e8eaed}
.status{text-align:center;margin-top:16px;padding:12px;border-radius:8px;font-size:14px;display:none}
.status.ok{display:block;background:#e8f5e9;color:#2e7d32}
.status.err{display:block;background:#ffeaea;color:#c62828}
.status.info{display:block;background:#e3f2fd;color:#1565c0}
.manual{margin-top:8px}
.manual input{display:none}
.manual label{font-size:13px;color:#4a6cf7;cursor:pointer;text-align:center;display:block}
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <span>🦀</span>
    <h1>Claw Box 配网</h1>
    <p>将设备连接到您的 WiFi</p>
  </div>
  <div class="device-id">设备 ID: <strong>${this._clawId}</strong></div>

  <button class="btn btn-scan" onclick="doScan()">🔍 扫描 WiFi</button>

  <div class="field">
    <label for="ssid">WiFi 网络</label>
    <select id="ssid"><option value="">-- 点击上方扫描 --</option></select>
  </div>

  <div class="manual">
    <input type="checkbox" id="manualToggle" onchange="toggleManual()">
    <label for="manualToggle">手动输入 SSID</label>
    <input type="text" id="manualSsid" placeholder="输入 WiFi 名称" style="display:none;margin-top:8px">
  </div>

  <div class="field" style="margin-top:16px">
    <label for="password">密码</label>
    <input type="password" id="password" placeholder="WiFi 密码（开放网络留空）">
  </div>

  <button class="btn" id="connectBtn" onclick="doConnect()">连接</button>
  <div class="status" id="status"></div>
</div>

<script>
function $(id){return document.getElementById(id)}
function setStatus(msg,type){var s=$('status');s.textContent=msg;s.className='status '+type}

async function doScan(){
  $('connectBtn').disabled=true;
  setStatus('正在扫描...','info');
  try{
    var r=await fetch('/api/scan');
    var d=await r.json();
    var sel=$('ssid');
    sel.innerHTML='<option value="">-- 请选择 --</option>';
    (d.wifi||[]).forEach(function(w){
      var o=document.createElement('option');
      o.value=w.ssid;
      o.textContent=w.ssid+' ('+w.signal+'% '+w.security+')';
      sel.appendChild(o);
    });
    setStatus('扫描到 '+d.wifi.length+' 个网络','ok');
  }catch(e){setStatus('扫描失败: '+e.message,'err')}
  $('connectBtn').disabled=false;
}

function toggleManual(){
  var on=$('manualToggle').checked;
  $('manualSsid').style.display=on?'block':'none';
  $('ssid').style.display=on?'none':'block';
}

async function doConnect(){
  var ssid=$('manualToggle').checked?$('manualSsid').value:$('ssid').value;
  var pw=$('password').value;
  if(!ssid){setStatus('请选择或输入 WiFi','err');return}
  $('connectBtn').disabled=true;
  setStatus('正在连接 '+ssid+' ...','info');
  try{
    var r=await fetch('/api/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ssid:ssid,password:pw})});
    var d=await r.json();
    if(d.success){
      setStatus('✓ 正在连接，请稍候... 设备将自动重启网络','ok');
      setTimeout(function(){setStatus('✓ 配网成功！您可以断开此热点','ok')},8000);
    }else{
      setStatus('连接失败: '+(d.error||'未知错误'),'err');
      $('connectBtn').disabled=false;
    }
  }catch(e){
    setStatus('连接失败: '+e.message,'err');
    $('connectBtn').disabled=false;
  }
}

doScan();
</script>
</body>
</html>`;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 4096) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

module.exports = { CaptiveServer };
