#!/usr/bin/env bash
# 将本机 clawd 源码同步到已安装过 clawd 的盒子并重启服务。
#
# 前置：设备上已至少执行过一次 install.sh（/opt/clawd、systemd、/etc/clawd 已就绪）。
# 通用功能可先跑通；VFD/LED 与 3566 不一致时，进程内会打 warn，不影响 WS/配网/frp。
#
# 用法（在仓库根或 tools 下）：
#   bash tools/deploy-rsync.sh
#   TARGET_HOST=192.168.1.105 TARGET_USER=sts bash tools/deploy-rsync.sh
#
# 依赖：本机 ssh、rsync；设备上 sts 能 sudo（首次 sudo 会提示密码）。
#
set -euo pipefail

TARGET_HOST="${TARGET_HOST:-192.168.1.104}"
TARGET_USER="${TARGET_USER:-sts}"
REMOTE_TMP="/home/${TARGET_USER}/clawd-rsync-staging"
REMOTE_OPT="/opt/clawd"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "[deploy] ${ROOT}/ -> ${TARGET_USER}@${TARGET_HOST}:${REMOTE_TMP} -> sudo ${REMOTE_OPT}"

rsync -avz --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude .cursor \
  --exclude '*.log' \
  "${ROOT}/" "${TARGET_USER}@${TARGET_HOST}:${REMOTE_TMP}/"

ssh "${TARGET_USER}@${TARGET_HOST}" \
  "sudo rsync -a ${REMOTE_TMP}/ ${REMOTE_OPT}/ && \
   sudo npm install --prefix ${REMOTE_OPT} --omit=dev && \
   sudo systemctl restart clawd && \
   sudo systemctl --no-pager -l status clawd || true"

echo "[deploy] 完成。跟踪日志: ssh ${TARGET_USER}@${TARGET_HOST} 'sudo journalctl -u clawd -f'"
