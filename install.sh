#!/usr/bin/env bash
# clawd 一键安装脚本
# 用法：curl -fsSL https://raw.githubusercontent.com/stswangzhiping/clawd/main/install.sh | bash
# 需要 root 权限，需要已安装 Node.js >= 18

set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

info()  { echo -e "${GREEN}[clawd]${NC} $*"; }
warn()  { echo -e "${YELLOW}[clawd]${NC} $*"; }
error() { echo -e "${RED}[clawd]${NC} $*"; exit 1; }

# ── 检查 root ────────────────────────────────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
  error "请以 root 身份运行（sudo bash install.sh）"
fi

# ── 检查 Node.js ─────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  error "未找到 Node.js，请先安装 Node.js >= 18"
fi

NODE_VER=$(node -e "process.stdout.write(process.versions.node)")
MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
if [ "$MAJOR" -lt 18 ]; then
  error "Node.js 版本过低（当前 $NODE_VER），需要 >= 18"
fi
info "Node.js $NODE_VER ✓"

# ── 检查/安装 dnsmasq（WiFi 配网需要）──────────────────────────────────────
if ! command -v dnsmasq &>/dev/null; then
  info "安装 dnsmasq（WiFi 配网所需）..."
  if command -v apt-get &>/dev/null; then
    apt-get install -y -qq dnsmasq >/dev/null 2>&1
  elif command -v yum &>/dev/null; then
    yum install -y -q dnsmasq >/dev/null 2>&1
  elif command -v apk &>/dev/null; then
    apk add --quiet dnsmasq >/dev/null 2>&1
  else
    warn "无法自动安装 dnsmasq，WiFi 配网功能可能不可用"
  fi
  # 禁止 dnsmasq 系统服务自启（clawd 自己管理）
  systemctl disable dnsmasq 2>/dev/null || true
  systemctl stop dnsmasq 2>/dev/null || true
fi
if command -v dnsmasq &>/dev/null; then
  info "dnsmasq ✓"
fi

# ── 启用 NetworkManager（WiFi 配网需要）──────────────────────────────────────
if command -v nmcli &>/dev/null; then
  if ! systemctl is-active --quiet NetworkManager 2>/dev/null; then
    info "启用 NetworkManager..."
    systemctl enable --now NetworkManager 2>/dev/null || true
  fi
  info "NetworkManager ✓"

  # 预写 DNS 劫持配置（运行时 /etc 可能为只读）
  NM_DNSMASQ_DIR="/etc/NetworkManager/dnsmasq-shared.d"
  mkdir -p "$NM_DNSMASQ_DIR"
  cat > "$NM_DNSMASQ_DIR/clawd-captive.conf" << 'DNSCONF'
# clawd captive portal DNS hijack
# All DNS queries resolve to gateway to trigger captive portal
address=/#/10.42.0.1
DNSCONF
  info "DNS 劫持配置已写入 $NM_DNSMASQ_DIR ✓"
fi

# ── WiFi rfkill 解锁（部分设备默认禁用 WiFi）────────────────────────────────
for rf in /sys/class/rfkill/rfkill*; do
  if [ -f "$rf/type" ] && [ "$(cat "$rf/type")" = "wlan" ]; then
    if [ "$(cat "$rf/soft")" = "1" ]; then
      info "解锁 WiFi ($(basename "$rf"))..."
      echo 0 > "$rf/soft"
    fi
  fi
done

# 持久化：独立脚本 + systemd 服务，确保开机自动解锁 WiFi
RFKILL_SCRIPT="/usr/local/bin/clawd-unblock-wifi.sh"
cat > "$RFKILL_SCRIPT" << 'SCRIPT'
#!/bin/sh
for rf in /sys/class/rfkill/rfkill*; do
  [ -f "$rf/type" ] || continue
  if [ "$(cat "$rf/type")" = "wlan" ] && [ "$(cat "$rf/soft")" = "1" ]; then
    echo 0 > "$rf/soft"
    echo "clawd-rfkill: unblocked $(basename "$rf")"
  fi
done
SCRIPT
chmod +x "$RFKILL_SCRIPT"

RFKILL_SERVICE="/etc/systemd/system/clawd-rfkill.service"
cat > "$RFKILL_SERVICE" << 'UNIT'
[Unit]
Description=Unblock WiFi for clawd
Before=NetworkManager.service clawd.service
After=sys-subsystem-net-devices-wlan0.device

[Service]
Type=oneshot
ExecStart=/usr/local/bin/clawd-unblock-wifi.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable clawd-rfkill
info "WiFi rfkill 解锁服务已创建 ✓"

# ── 安装 clawd ───────────────────────────────────────────────────────────────
INSTALL_DIR="/opt/clawd"
CONFIG_DIR="/etc/clawd"
ENV_FILE="$CONFIG_DIR/env"
info "安装到 $INSTALL_DIR ..."

mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# 下载源码（若目录已有 package.json，视为离线/已解压部署，跳过 git/tarball；避免设备无法访问 github.com）
if [ -f "package.json" ]; then
  info "检测到已有源码，跳过 git/tarball 下载"
elif command -v git &>/dev/null; then
  if [ -d ".git" ]; then
    git pull --quiet
  else
    git clone --depth=1 https://github.com/stswangzhiping/clawd.git .
  fi
else
  TARBALL_URL="https://github.com/stswangzhiping/clawd/archive/refs/heads/main.tar.gz"
  curl -fsSL "$TARBALL_URL" | tar -xz --strip-components=1
fi

# 安装依赖
info "安装 npm 依赖..."
npm install --omit=dev --silent

# 创建可执行链接
ln -sf "$INSTALL_DIR/bin/clawd.js" /usr/local/bin/clawd
chmod +x "$INSTALL_DIR/bin/clawd.js"

info "clawd 已安装到 /usr/local/bin/clawd ✓"

# ── 创建配置目录 + 环境变量文件 ──────────────────────────────────────────────
mkdir -p "$CONFIG_DIR"

if [ ! -f "$CONFIG_DIR/config.json" ]; then
  cat > "$CONFIG_DIR/config.json" <<EOF
{
  "server": "wss://claw.cutos.ai/ws",
  "claw_id": null,
  "token": null,
  "heartbeat_interval": 30
}
EOF
  info "配置文件已创建：$CONFIG_DIR/config.json ✓"
fi

if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<EOF
# clawd 环境变量（systemd EnvironmentFile）
# 日志级别: debug / info / warn / error
CLAWD_LOG_LEVEL=info
# 是否写日志文件（0=仅 journald）
CLAWD_LOG_FILE=1
# 自定义服务器地址（留空则读 config.json）
# CLAWD_SERVER=wss://claw.cutos.ai/ws
EOF
  info "环境变量文件已创建：$ENV_FILE ✓"
fi

# ── 创建日志目录 ─────────────────────────────────────────────────────────────
mkdir -p "$CONFIG_DIR/logs"
info "日志目录：$CONFIG_DIR/logs ✓"

# ── 创建 systemd service ────────────────────────────────────────────────────
NODE_BIN=$(command -v node)
SERVICE_FILE="/etc/systemd/system/clawd.service"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Claw Box Daemon
Documentation=https://github.com/stswangzhiping/clawd
After=NetworkManager.service
Wants=NetworkManager.service

[Service]
Type=simple
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $INSTALL_DIR/bin/clawd.js
WorkingDirectory=$INSTALL_DIR

# 重启策略
Restart=always
RestartSec=5
# 旧版 systemd 不认 StartLimitIntervalSec，用 StartLimitInterval=（秒）
StartLimitInterval=300
StartLimitBurst=10

# 优雅停止（10s 内 SIGTERM，超时 SIGKILL）
TimeoutStopSec=10
KillMode=mixed
KillSignal=SIGTERM

# 资源限制（防止失控）
MemoryMax=256M
CPUQuota=50%
TasksMax=64

# 安全加固（ttyd 子进程需要 setuid sudo，不能用 NoNewPrivileges/strict）
ProtectSystem=full
ReadWritePaths=$CONFIG_DIR /tmp

# 日志
StandardOutput=journal
StandardError=journal
SyslogIdentifier=clawd

# systemd Watchdog（60s 无响应视为挂死）
WatchdogSec=60

[Install]
WantedBy=multi-user.target
EOF

info "systemd 服务文件已创建 ✓"

# ── journald 日志限制（可选） ────────────────────────────────────────────────
JOURNAL_CONF="/etc/systemd/journald.conf.d/clawd.conf"
if [ ! -f "$JOURNAL_CONF" ]; then
  mkdir -p /etc/systemd/journald.conf.d
  cat > "$JOURNAL_CONF" <<EOF
# clawd journald 限制
[Journal]
SystemMaxUse=100M
MaxFileSec=7day
EOF
  systemctl restart systemd-journald 2>/dev/null || true
  info "journald 日志限制已配置 ✓"
fi

# ── 启用并启动 ──────────────────────────────────────────────────────────────
systemctl daemon-reload
systemctl enable clawd
systemctl restart clawd

sleep 2
if systemctl is-active --quiet clawd; then
  info "clawd 服务运行中 ✓"
  echo ""
  echo "  查看日志：  journalctl -u clawd -f"
  echo "  查看状态：  systemctl status clawd"
  echo "  停止服务：  systemctl stop clawd"
  echo "  配置文件：  $CONFIG_DIR/config.json"
  echo "  环境变量：  $ENV_FILE"
  echo "  文件日志：  $CONFIG_DIR/logs/clawd.log"
  echo ""
else
  warn "服务启动失败，请检查日志："
  echo "  journalctl -u clawd -n 50 --no-pager"
fi
