#!/bin/bash
# 在 BOX 上由 sudo 执行：先解压本机 tarball，再运行包内 install.sh（避免 raw.githubusercontent CDN 滞后；离线机也可不用 curl）。
set -euo pipefail
rm -rf /opt/clawd
mkdir -p /opt/clawd
tar xzf "${1:-$HOME/clawd-deploy.tgz}" -C /opt/clawd
exec bash /opt/clawd/install.sh
