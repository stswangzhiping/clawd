# clawd

Claw Box 守护进程，将本地 Linux 设备通过 WebSocket 长连接接入 [claw.cutos.ai](https://claw.cutos.ai)。

## 功能

- 自动生成硬件唯一指纹（`box_id`）
- 首次连接自动注册，获取 `claw_id` + `token` 并持久化
- 每 30 秒上报系统指标（CPU、内存、磁盘、温度、负载、运行时间）
- 断线自动重连（指数退避，最大 60 秒）
- systemd 管理，开机自启

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
[clawd] 启动中...
[clawd] box_id    = a1b2c3d4e5f6...
[clawd] 服务器    = wss://claw.cutos.ai/ws
[clawd] WebSocket 已连接
[clawd] 注册成功！claw_id = 1000

╔══════════════════════════════════╗
║  激活 PIN 码：  779413          ║
║  请在管理后台或前台输入此 PIN 码  ║
╚══════════════════════════════════╝

[clawd] 等待激活中，心跳正常运行...
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

## 服务管理

```bash
systemctl status clawd      # 查看状态
journalctl -u clawd -f      # 实时日志
systemctl restart clawd     # 重启
systemctl stop clawd        # 停止
systemctl disable clawd     # 取消开机自启
```

## 心跳上报字段

| 字段 | 说明 | 单位 |
|------|------|------|
| `cpu` | CPU 使用率 | % |
| `mem_total` / `mem_used` | 内存总量 / 已用 | KB |
| `disk_total` / `disk_used` | 根分区总量 / 已用 | KB |
| `temperature` | CPU 温度 | °C |
| `load_1m` / `load_5m` / `load_15m` | 系统负载 | — |
| `uptime` | 运行时间 | 秒 |

## License

MIT
