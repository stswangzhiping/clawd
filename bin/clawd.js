#!/usr/bin/env node
'use strict';

const { ClawClient } = require('../lib/client');

const client = new ClawClient();
client.start();

// 优雅退出
process.on('SIGINT',  () => { client.stop(); process.exit(0); });
process.on('SIGTERM', () => { client.stop(); process.exit(0); });
