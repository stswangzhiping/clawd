'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { execSync } = require('child_process');
const log = require('./logger');
const { resolveOpenclawConfigFile } = require('./frpc');

const DEFAULT_BASE_URL = 'https://api.cutos.ai/v1';
const FETCH_TIMEOUT_MS = 10_000;

/** 拉模型 + 写盘单次飞行：进行中则忽略新的 apply/remove */
let _busy = false;

/**
 * 终止 openclaw-gateway 进程，由 systemd --user 自动重新拉起以读取新配置。
 * 每次写盘 openclaw.json 成功后应调用一次。
 */
function restartGateway() {
  try {
    execSync('pkill -9 -x openclaw-gateway', { timeout: 3000 });
    log.info('openclaw-provider', 'openclaw-gateway 已终止，等待自动重启');
  } catch (_) {
    log.info('openclaw-provider', 'openclaw-gateway 进程不存在，无需终止');
  }
}

function authProfilesPathFromConfig(configFile) {
  return path.join(path.dirname(configFile), 'agents', 'main', 'agent', 'auth-profiles.json');
}

function buildModelsUrl(baseUrl) {
  let u = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!/\/v1$/.test(u)) u = `${u}/v1`;
  return `${u}/models`;
}

/**
 * 异步 GET /v1/models，不阻塞；完成回调 (err, models)，models 为 { id, name }[]
 */
function fetchModels(baseUrl, apiKey, callback) {
  const urlStr = buildModelsUrl(baseUrl);
  let u;
  try {
    u = new URL(urlStr);
  } catch (e) {
    callback(new Error(`invalid base-url: ${urlStr}`));
    return;
  }
  const lib = u.protocol === 'https:' ? https : http;
  const opts = {
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: `${u.pathname}${u.search || ''}`,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey || ''}`,
      'Content-Type': 'application/json',
    },
  };

  log.info('openclaw-provider', `GET models: ${urlStr}`);

  const req = lib.request(opts, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      try {
        const json = JSON.parse(data);
        if (json.data && Array.isArray(json.data)) {
          callback(null, json.data.map((m) => ({ id: m.id, name: m.id })));
        } else if (json.error) {
          callback(new Error(json.error.message || JSON.stringify(json.error)));
        } else {
          callback(new Error(`bad models response: ${data.slice(0, 200)}`));
        }
      } catch (e) {
        callback(new Error(`parse models: ${e.message}`));
      }
    });
  });

  req.on('error', callback);
  req.setTimeout(FETCH_TIMEOUT_MS, () => {
    req.destroy();
    callback(new Error('models request timeout'));
  });
  req.end();
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonFile(filePath, obj) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

/**
 * 同步：从 openclaw.json + auth-profiles.json 删除指定 provider（解绑）。
 * 若 primary 指向该 provider，先置为空串。
 */
function removeProviderByName(providerId) {
  if (_busy) {
    log.warn('openclaw-provider', `跳过 remove（provider 应用进行中）: ${providerId}`);
    return;
  }
  const configFile = resolveOpenclawConfigFile();
  if (!configFile) {
    log.warn('openclaw-provider', 'remove: 未找到 openclaw.json');
    return;
  }

  const config = readJsonFile(configFile);
  const primary = config.agents?.defaults?.model?.primary || '';
  if (primary.startsWith(`${providerId}/`)) {
    if (!config.agents) config.agents = { defaults: {} };
    if (!config.agents.defaults) config.agents.defaults = {};
    if (!config.agents.defaults.model) config.agents.defaults.model = {};
    config.agents.defaults.model.primary = '';
    log.info('openclaw-provider', `已清空默认模型 primary（原 ${primary}）`);
  }

  if (config.models?.providers?.[providerId]) {
    delete config.models.providers[providerId];
    log.info('openclaw-provider', `已删除 models.providers.${providerId}`);
  }

  if (config.agents?.defaults?.models) {
    const prefix = `${providerId}/`;
    Object.keys(config.agents.defaults.models).forEach((key) => {
      if (key.startsWith(prefix)) delete config.agents.defaults.models[key];
    });
  }

  if (config.auth?.profiles) {
    delete config.auth.profiles[`${providerId}:default`];
  }

  writeJsonFile(configFile, config);

  const authPath = authProfilesPathFromConfig(configFile);
  try {
    if (fs.existsSync(authPath)) {
      const authProfiles = readJsonFile(authPath);
      if (authProfiles.profiles?.[`${providerId}:default`]) {
        delete authProfiles.profiles[`${providerId}:default`];
        writeJsonFile(authPath, authProfiles);
      }
    }
  } catch (e) {
    log.warn('openclaw-provider', `auth-profiles 更新失败: ${e.message}`);
  }

  log.info('openclaw-provider', `provider 已移除: ${providerId}`);
  restartGateway();
}

function removeProviderFromConfig(config, providerId) {
  if (config.models?.providers?.[providerId]) {
    delete config.models.providers[providerId];
  }
  if (config.agents?.defaults?.models) {
    const prefix = `${providerId}/`;
    Object.keys(config.agents.defaults.models).forEach((key) => {
      if (key.startsWith(prefix)) delete config.agents.defaults.models[key];
    });
  }
  if (config.auth?.profiles) {
    delete config.auth.profiles[`${providerId}:default`];
  }
}

function addProviderSync(configFile, providerId, baseUrl, apiKey, models, defaultModelRaw) {
  const config = readJsonFile(configFile);

  removeProviderFromConfig(config, providerId);

  if (!config.models) config.models = { mode: 'merge', providers: {} };
  if (!config.models.providers) config.models.providers = {};
  config.models.mode = 'merge';

  let cleanBase = String(baseUrl || '').replace(/\/+$/, '');
  if (!/\/v1$/.test(cleanBase)) cleanBase = `${cleanBase}/v1`;

  config.models.providers[providerId] = {
    baseUrl: cleanBase,
    apiKey,
    api: 'openai-completions',
    models,
  };

  if (!config.agents) config.agents = { defaults: {} };
  if (!config.agents.defaults) config.agents.defaults = {};
  if (!config.agents.defaults.models) config.agents.defaults.models = {};

  models.forEach((m) => {
    const fullId = `${providerId}/${m.id}`;
    if (!config.agents.defaults.models[fullId]) config.agents.defaults.models[fullId] = {};
  });

  if (defaultModelRaw) {
    const dm = String(defaultModelRaw).trim();
    const defaultFull = dm.includes('/') ? dm : `${providerId}/${dm}`;
    if (!config.agents.defaults.model) config.agents.defaults.model = {};
    config.agents.defaults.model.primary = defaultFull;
    log.info('openclaw-provider', `默认模型: ${defaultFull}`);
  }

  if (!config.auth) config.auth = { profiles: {} };
  if (!config.auth.profiles) config.auth.profiles = {};
  config.auth.profiles[`${providerId}:default`] = {
    provider: providerId,
    mode: 'api_key',
  };

  writeJsonFile(configFile, config);

  const authPath = authProfilesPathFromConfig(configFile);
  try {
    let authProfiles = { profiles: {} };
    if (fs.existsSync(authPath)) {
      authProfiles = readJsonFile(authPath);
      if (!authProfiles.profiles) authProfiles.profiles = {};
    }
    authProfiles.profiles[`${providerId}:default`] = {
      type: 'api_key',
      provider: providerId,
      key: apiKey,
    };
    writeJsonFile(authPath, authProfiles);
  } catch (e) {
    log.warn('openclaw-provider', `auth-profiles 写入失败: ${e.message}`);
  }

  log.info('openclaw-provider', `provider 已写入: ${providerId}（${models.length} 个模型）`);
}

/**
 * VPS 绑定：先同步删掉同名 provider，再异步拉模型，回调内同步 add。完成后执行 onDone（如更新 origin）。
 */
function applyFullProviderFromVps(provider, onDone) {
  if (_busy) {
    log.warn('openclaw-provider', '跳过 apply（上一次 provider 操作尚未结束）');
    return;
  }
  const name = provider && provider.name;
  if (!name || typeof name !== 'string') {
    log.warn('openclaw-provider', 'apply: provider.name 无效');
    return;
  }

  const baseUrl = provider['base-url'] || provider.baseUrl || DEFAULT_BASE_URL;
  const apiKey = provider['api-key'] != null ? String(provider['api-key']) : '';
  const defaultModel = provider['default-model'] != null ? String(provider['default-model']) : '';

  const configFile = resolveOpenclawConfigFile();
  if (!configFile) {
    log.warn('openclaw-provider', 'apply: 未找到 openclaw.json');
    return;
  }

  _busy = true;
  try {
    const cfg = readJsonFile(configFile);
    removeProviderFromConfig(cfg, name);
    writeJsonFile(configFile, cfg);
  } catch (e) {
    log.warn('openclaw-provider', `apply 预清理失败: ${e.message}`);
    _busy = false;
    return;
  }

  fetchModels(baseUrl, apiKey, (err, models) => {
    try {
      const list = err ? [] : models;
      if (err) {
        log.warn('openclaw-provider', `拉模型失败，使用空列表: ${err.message}`);
      }
      addProviderSync(configFile, name, baseUrl, apiKey, list, defaultModel);
      restartGateway();
      if (typeof onDone === 'function') {
        try {
          onDone();
        } catch (e) {
          log.warn('openclaw-provider', `onDone: ${e.message}`);
        }
      }
    } catch (e) {
      log.error('openclaw-provider', `apply 写配置失败: ${e.message}`);
    } finally {
      _busy = false;
    }
  });
}

/** 与解绑区分：解绑仅含 name，绑定含 base-url（或 baseUrl） */
function isFullProvider(p) {
  if (!p || typeof p.name !== 'string' || !p.name) return false;
  return Object.prototype.hasOwnProperty.call(p, 'base-url')
    || Object.prototype.hasOwnProperty.call(p, 'baseUrl');
}

module.exports = {
  applyFullProviderFromVps,
  removeProviderByName,
  isFullProvider,
  DEFAULT_BASE_URL,
};
