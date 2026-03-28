'use strict';

/**
 * 在任意子进程（nmcli、pkill、frpc、依赖库）启动前，从 process.env 摘掉 NOTIFY_SOCKET。
 * 否则子进程继承后可能向 systemd 发 sd_notify，触发「仅主 PID 可收」的 journal 刷屏。
 * 主进程通过 getNotifySocket() 取回路径，自行 unix_dgram 发送。
 */
const _notifySocket = process.env.NOTIFY_SOCKET;
if (_notifySocket) {
  delete process.env.NOTIFY_SOCKET;
}

function getNotifySocket() {
  return _notifySocket;
}

module.exports = { getNotifySocket };
