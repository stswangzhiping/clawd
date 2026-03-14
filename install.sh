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

# ── 安装 clawd ───────────────────────────────────────────────────────────────
INSTALL_DIR="/opt/clawd"
info "安装到 $INSTALL_DIR ..."

mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# 下载源码
if command -v git &>/dev/null; then
  if [ -d ".git" ]; then
    git pull --quiet
  else
    git clone --depth=1 https://github.com/stswangzhiping/clawd.git .
  fi
else
  # 无 git 时用 curl 下载 tarball
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

# ── 创建配置目录 ──────────────────────────────────────────────────────────────
mkdir -p /etc/clawd
if [ ! -f /etc/clawd/config.json ]; then
  cat > /etc/clawd/config.json <<EOF
{
  "server": "wss://claw.cutos.ai/ws",
  "claw_id": null,
  "token": null,
  "heartbeat_interval": 30
}
EOF
  info "配置文件已创建：/etc/clawd/config.json ✓"
fi

# ── 创建 systemd service ──────────────────────────────────────────────────────
NODE_BIN=$(command -v node)
SERVICE_FILE="/etc/systemd/system/clawd.service"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Claw Box Daemon
Documentation=https://github.com/stswangzhiping/clawd
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$NODE_BIN $INSTALL_DIR/bin/clawd.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=clawd

[Install]
WantedBy=multi-user.target
EOF

# ── 启用并启动 ─────────────────────────────────────────────────────────────────
systemctl daemon-reload
systemctl enable clawd
systemctl restart clawd

sleep 2
if systemctl is-active --quiet clawd; then
  info "clawd 服务运行中 ✓"
  echo ""
  echo "  查看日志：journalctl -u clawd -f"
  echo "  查看状态：systemctl status clawd"
  echo "  停止服务：systemctl stop clawd"
  echo ""
else
  warn "服务启动失败，请检查日志：journalctl -u clawd -n 30"
fi
