'use strict';

const http = require('http');
const log  = require('./logger');
// scanWifi 不再在此调用（AP 模式下无法扫描），改用缓存
const { CAPTIVE_DOMAIN } = require('./dns-hijack');

const PORT = 80;

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
 * 配网 HTTP 服务器（回调模式）。
 *
 * 路由：
 *   GET  /             → 配网页面（HTML）
 *   GET  /api/scan     → WiFi 扫描结果 JSON
 *   POST /api/connect  → 提交 WiFi 凭证，触发 onConnect 回调
 *   GET  /api/status   → 当前连接状态
 *   Captive Portal 检测 → 302 重定向到配网页
 */
class CaptiveServer {
  constructor(opts = {}) {
    this._server        = null;
    this._clawId        = opts.clawId || '???';
    this._onConnect     = opts.onConnect || null;
    this._cachedWifiList = opts.cachedWifiList || [];
  }

  startListening() {
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
        log.error('http', `端口 ${PORT} 无权限，请以 root 运行`);
      } else if (e.code === 'EADDRINUSE') {
        log.error('http', `端口 ${PORT} 已被占用`);
      } else {
        log.error('http', '服务器错误:', e.message);
      }
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

    if (CAPTIVE_DETECT_PATHS.has(pathname)) {
      res.writeHead(302, { Location: `http://${CAPTIVE_DOMAIN}/` });
      res.end();
      return;
    }

    if (pathname === '/api/scan' && req.method === 'GET') {
      return this._apiScan(req, res);
    }
    if (pathname === '/api/connect' && req.method === 'POST') {
      return this._apiConnect(req, res);
    }
    if (pathname === '/api/status' && req.method === 'GET') {
      return this._apiStatus(req, res);
    }

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(this._renderPage());
  }

  // ── API ──────────────────────────────────────────────────────────────────

  _apiScan(req, res) {
    // AP 模式下 wlan0 无法扫描，返回开 AP 前的缓存结果
    this._json(res, { wifi: this._cachedWifiList, cached: true });
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

    // 先返回响应，让手机端知道设备收到了请求
    // （AP 即将关闭，手机会断开连接）
    this._json(res, { success: true, message: '正在连接，AP 将临时关闭...' });

    // 延迟执行，确保 HTTP 响应送达
    if (this._onConnect) {
      setTimeout(() => {
        Promise.resolve(this._onConnect(ssid, password || '')).catch((e) => {
          log.error('http', '配网回调异常:', e.message);
        });
      }, 1000);
    }
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
input{width:100%;padding:12px;border:1.5px solid #ddd;border-radius:8px;font-size:15px;outline:none;transition:border-color .2s}
input:focus{border-color:#4a6cf7}
.pw-wrap{position:relative}
.pw-wrap input{padding-right:42px}
.pw-eye{position:absolute;right:12px;top:50%;transform:translateY(-50%);cursor:pointer;color:#aaa;line-height:1;font-size:18px;user-select:none}
.pw-eye:hover{color:#555}
.field{margin-bottom:16px}
.wifi-list{max-height:220px;overflow-y:auto;border:1.5px solid #ddd;border-radius:8px;margin-bottom:16px}
.wifi-item{display:flex;align-items:center;padding:10px 12px;border-bottom:1px solid #f0f0f0;cursor:pointer;font-size:13px;transition:background .15s}
.wifi-item:last-child{border-bottom:none}
.wifi-item:hover,.wifi-item.active{background:#e8f0fe}
.wifi-item.active{font-weight:600;color:#1a1a2e}
.wifi-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wifi-signal{display:flex;align-items:flex-end;gap:1.5px;height:14px;margin-left:8px;flex-shrink:0}
.wifi-signal i{display:block;width:3px;background:#ccc;border-radius:1px}
.wifi-signal i.on{background:#4a6cf7}
.wifi-lock{margin-left:6px;font-size:11px;color:#888;flex-shrink:0}
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

  <div class="field">
    <label>请选择下列 WiFi 网络</label>
    <div class="wifi-list" id="wifiList"><div style="padding:12px;text-align:center;color:#999;font-size:13px">加载中...</div></div>
  </div>

  <div class="manual">
    <input type="checkbox" id="manualToggle" onchange="toggleManual()">
    <label for="manualToggle">手动输入 SSID</label>
    <input type="text" id="manualSsid" placeholder="输入 WiFi 名称" style="display:none;margin-top:8px">
  </div>
  <input type="hidden" id="selectedSsid" value="">

  <div class="field" style="margin-top:16px">
    <label for="password">密码</label>
    <div class="pw-wrap">
      <input type="password" id="password" placeholder="WiFi 密码（开放网络留空）">
      <span class="pw-eye" id="pwEye" style="opacity:0.4" onclick="togglePw()">👁</span>
    </div>
  </div>

  <button class="btn" id="connectBtn" onclick="doConnect()">连接</button>
  <div class="status" id="status"></div>
</div>

<script>
function $(id){return document.getElementById(id)}
function setStatus(msg,type){var s=$('status');s.textContent=msg;s.className='status '+type}
function togglePw(){var i=$('password');var show=i.type==='password';i.type=show?'text':'password';$('pwEye').style.opacity=show?'1':'0.4'}

function signalBars(pct){
  var bars=[4,7,10,14];
  var on=pct>=80?4:pct>=60?3:pct>=40?2:1;
  return bars.map(function(h,i){
    return '<i style="height:'+h+'px" class="'+(i<on?'on':'')+'"></i>';
  }).join('');
}

function selectWifi(ssid){
  $('selectedSsid').value=ssid;
  var items=document.querySelectorAll('.wifi-item');
  items.forEach(function(el){el.classList.toggle('active',el.dataset.ssid===ssid)});
}

async function doScan(){
  var list=$('wifiList');
  list.innerHTML='<div style="padding:12px;text-align:center;color:#999;font-size:13px">加载中...</div>';
  try{
    var r=await fetch('/api/scan');
    var d=await r.json();
    var arr=d.wifi||[];
    if(arr.length===0){
      list.innerHTML='<div style="padding:12px;text-align:center;color:#999;font-size:13px">未发现网络，请手动输入</div>';
      return;
    }
    list.innerHTML='';
    arr.forEach(function(w){
      var div=document.createElement('div');
      div.className='wifi-item';
      div.dataset.ssid=w.ssid;
      div.onclick=function(){selectWifi(w.ssid)};
      var lock=w.security&&w.security!=='Open'?'🔒':'';
      div.innerHTML='<span class="wifi-name">'+w.ssid+'</span>'
        +'<span class="wifi-signal">'+signalBars(w.signal)+'</span>'
        +'<span class="wifi-lock">'+lock+'</span>';
      list.appendChild(div);
    });
  }catch(e){
    list.innerHTML='<div style="padding:12px;text-align:center;color:#c62828;font-size:13px">加载失败</div>';
  }
}

function toggleManual(){
  var on=$('manualToggle').checked;
  $('manualSsid').style.display=on?'block':'none';
  $('wifiList').style.display=on?'none':'block';
}

async function doConnect(){
  var ssid=$('manualToggle').checked?$('manualSsid').value:$('selectedSsid').value;
  var pw=$('password').value;
  if(!ssid){setStatus('请选择或输入 WiFi','err');return}
  $('connectBtn').disabled=true;
  setStatus('正在连接 '+ssid+' ... 热点将临时关闭','info');
  try{
    var r=await fetch('/api/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ssid:ssid,password:pw})});
    var d=await r.json();
    if(d.success){
      setStatus('✓ 设备正在连接 WiFi，热点将关闭。如连接失败，热点会自动恢复。','ok');
    }else{
      setStatus('失败: '+(d.error||'未知错误'),'err');
      $('connectBtn').disabled=false;
    }
  }catch(e){
    setStatus('请求失败: '+e.message,'err');
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
