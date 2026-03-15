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
│   └── watchdog.js        ← 通用子进程守护（速率限制重启）
├── install.sh             ← 一键安装（含 systemd）
└── package.json
```

## License

MIT
