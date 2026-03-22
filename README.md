# clawd

Claw Box 守护进程，将本地 Linux 设备通过 WebSocket 长连接接入 [claw.cutos.ai](https://claw.cutos.ai)。

## 功能

- 自动生成硬件唯一指纹（`box_id`）
- 首次连接自动注册，获取 `claw_id` + `token` 并持久化
- 每 30 秒上报系统指标（CPU、内存、磁盘、温度、负载、运行时间）
- 断线自动重连（指数退避，最大 60 秒）
- WS 层 Ping/Pong 活性检测，连接假死自动重连
- frpc / ttyd 子进程 Watchdog 守护，崩溃自动重启（速率限制）
- 结构化日志 + 文件轮转（5MB × 5 份）
- systemd 集成：Watchdog、资源限制、优雅停止
- 全局异常兜底（uncaughtException / unhandledRejection）

## 快速安装（Linux，需要 root）

```bash
curl -fsSL https://raw.githubusercontent.com/stswangzhiping/clawd/main/install.sh | sudo bash
```

要求：
- Node.js >= 18
- Linux（systemd）

## 手动运行（开发调试）

```bash
git clone https://github.com/stswangzhiping/clawd.git
cd clawd
npm install
node bin/clawd.js
```

## 首次启动输出示例

```
2026-03-16T10:00:00.000Z INFO  [clawd] 启动中... 服务器 = wss://claw.cutos.ai/ws
2026-03-16T10:00:01.000Z INFO  [clawd] WebSocket 已连接
2026-03-16T10:00:01.100Z INFO  [clawd] 注册成功！claw_id = 1000
2026-03-16T10:00:01.100Z INFO  [clawd]
2026-03-16T10:00:01.100Z INFO  [clawd] ╔════════════════════════════════════╗
2026-03-16T10:00:01.100Z INFO  [clawd] ║  Claw ID : 1000                   ║
2026-03-16T10:00:01.100Z INFO  [clawd] ║  PIN 码  : 779413                 ║
2026-03-16T10:00:01.100Z INFO  [clawd] ║  请在网页前台「添加设备」中输入    ║
2026-03-16T10:00:01.100Z INFO  [clawd] ╚════════════════════════════════════╝
2026-03-16T10:00:01.100Z INFO  [clawd]
2026-03-16T10:00:01.100Z INFO  [clawd] 等待激活，心跳正常运行...
```

## 配置文件

路径：`/etc/clawd/config.json`（root 运行）或 `~/.clawd/config.json`（普通用户）

```json
{
  "server": "wss://claw.cutos.ai/ws",
  "claw_id": 1000,
  "token": "6e0c182e...",
  "heartbeat_interval": 30
}
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CLAWD_LOG_LEVEL` | `info` | 日志级别：debug / info / warn / error |
| `CLAWD_LOG_FILE` | `1` | 是否写日志文件（`0` = 仅 stdout/journald） |
| `CLAWD_LOG_DIR` | `~/.clawd/logs` | 日志文件目录 |
| `CLAWD_CONFIG_DIR` | `~/.clawd` | 配置目录 |

systemd 安装后环境变量文件位于 `/etc/clawd/env`。

## 服务管理

```bash
systemctl status clawd      # 查看状态
journalctl -u clawd -f      # 实时日志
systemctl restart clawd      # 重启
systemctl stop clawd         # 停止
systemctl disable clawd      # 取消开机自启
```

## 更新

clawd 安装在 `/opt/clawd`，更新时需在该目录执行 `git pull`：

```bash
cd /opt/clawd && sudo git pull && sudo systemctl restart clawd
```

## 日志

- **stdout/journald**：所有日志同时输出到标准输出（systemd 自动采集到 journald）
- **文件日志**：`/etc/clawd/logs/clawd.log`，单文件 5MB，保留 5 份轮转

## 心跳上报字段

| 字段 | 说明 | 单位 |
|------|------|------|
| `cpu` | CPU 使用率 | % |
| `mem_total` / `mem_used` | 内存总量 / 已用 | KB |
| `disk_total` / `disk_used` | 磁盘总量 / 已用 | KB |
| `temperature` | CPU 温度 | °C |
| `load_1m` / `load_5m` / `load_15m` | 系统负载 | — |
| `uptime` | 运行时间 | 秒 |

## WiFi 配网（用户手册）

Claw Box 是无屏设备，通过 WiFi 热点完成网络配置。

### 什么时候会出现热点？

| 场景 | 热点状态 |
|------|----------|
| 首次开机，从未配过 WiFi | 立即开启 |
| 配过 WiFi，但信号范围外或密码已改 | 等待约 20 秒后自动开启 |
| WiFi 正常连接中 | 不开启 |
| 运行中 WiFi 突然断开 | 约 30 秒后自动开启 |

### 配网步骤

**第一步：找到热点**

打开手机 WiFi 设置，找到名为 **ClawBox-{设备ID}** 的热点（例如 `ClawBox-1002`）。
设备 ID 印在机身标签上。

**第二步：连接热点**

- 热点名称：`ClawBox-{设备ID}`
- 密码：**`12345678`**

**第三步：打开配网页面**

连接成功后，手机通常会**自动弹出配网页面**。

如果没有弹出，请手动打开浏览器访问：
- `http://10.42.0.1`

**第四步：选择 WiFi 并连接**

1. 点击 **「扫描 WiFi」** 按钮，等待扫描完成
2. 从下拉列表中选择您的 WiFi（或勾选「手动输入 SSID」）
3. 输入 WiFi 密码
4. 点击 **「连接」**

**第五步：等待连接**

- 设备会临时关闭热点，尝试连接您选择的 WiFi
- **连接成功**：热点不再出现，设备自动接入云端
- **连接失败**：热点会在几秒后重新出现，请重新连接热点再试

### 更换 WiFi

如果需要更换 WiFi（例如搬到新环境），只需等待设备检测到网络断开，
热点会自动重新出现，按上述步骤重新配网即可。

### 常见问题

| 问题 | 解决方法 |
|------|----------|
| 找不到 ClawBox 热点 | 等待 30 秒；确认设备已通电且指示灯正常 |
| 连上热点但页面打不开 | 手动访问 `http://10.42.0.1` |
| 扫描不到我的 WiFi | 点击刷新重试；确认路由器开启且距离不太远 |
| 输入密码后连接失败 | 检查密码是否正确；热点恢复后重试 |
| 配网成功但设备仍离线 | 检查路由器是否能上外网；稍等 1 分钟 |

### 系统要求

- `NetworkManager`（安装脚本自动启用）
- WiFi 硬件（wlan0）

## 架构

```
clawd/
├── bin/clawd.js           ← 入口，优雅停止
├── lib/
│   ├── client.js          ← 核心：WS 连接、心跳、Ping/Pong、sd-notify
│   ├── config.js          ← 配置读写
│   ├── fingerprint.js     ← 硬件指纹生成
│   ├── frpc.js            ← frpc/ttyd/dashboard 管理（Watchdog 守护）
│   ├── logger.js          ← 结构化日志 + 文件轮转
│   ├── metrics.js         ← 系统指标采集
│   ├── watchdog.js        ← 通用子进程守护（速率限制重启）
│   ├── network.js         ← 网络检测、WiFi 扫描/连接、AP 模式
│   ├── dns-hijack.js      ← DNS 劫持（NM dnsmasq-shared.d 配置）
│   ├── captive-server.js  ← 配网 HTTP 页面（Captive Portal）
│   └── provisioning.js    ← AP 常驻管理器（WiFi 状态监控）
├── install.sh             ← 一键安装（含 systemd + dnsmasq）
└── package.json
```

## License

MIT
