#!/usr/bin/env node
'use strict';

const { ClawClient } = require('../lib/client');
const log = require('../lib/logger');

const client = new ClawClient();
client.start();

let stopping = false;

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log.info('clawd', `收到 ${signal}，正在停止...`);
  client.stop();
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
