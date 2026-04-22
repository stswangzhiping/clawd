'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const log = require('./logger');
const { resolveOpenclawConfigFile } = require('./frpc');

const DEFAULT_BASE_URL = 'https://api.cutos.ai/v1';
const FETCH_TIMEOUT_MS = 10_000;

/** 拉模型 + 写盘单次飞行：进行中则忽略新的 apply/remove */
let _busy = false;

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
          callback(null, json.data.map((m) => ({ id: m.id, name: m.id, input: ['text', 'image'] })));
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
 * 同步：从 openclaw.json 删除指定 provider（解绑）。
 * 若 primary 指向该 provider，先置为空串。
 * gateway 检测到文件变更后会自动重启，无需 clawd 主动 kill。
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
  log.info('openclaw-provider', `provider 已移除: ${providerId}`);
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
  log.info('openclaw-provider', `provider 已写入: ${providerId}（${models.length} 个模型）`);
}

/**
 * VPS 绑定：异步拉模型后一次性写入 openclaw.json。
 * gateway 检测到文件变更后会自动重启，无需 clawd 主动 kill。
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

  fetchModels(baseUrl, apiKey, (err, models) => {
    try {
      const list = err ? [] : models;
      if (err) {
        log.warn('openclaw-provider', `拉模型失败，使用空列表: ${err.message}`);
      }
      addProviderSync(configFile, name, baseUrl, apiKey, list, defaultModel);
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

/**
 * 对模型列表计算 MD5（按 id 排序后 JSON 序列化），用于变更检测。
 */
function computeModelsMd5(models) {
  const ids = (models || []).map((m) => m.id).sort();
  return crypto.createHash('md5').update(JSON.stringify(ids)).digest('hex');
}

/**
 * 重连时刷新模型列表：读取现有 openclaw.json 中第一个 provider 的 baseUrl/apiKey，
 * 拉取最新模型，MD5 与现有模型对比，不一致才写盘（触发 gateway 自动重启）。
 * 若模型未变则跳过，不写盘，不触发 gateway 重启。
 * 完成后调用 onDone()（无论是否更新）。
 */
function refreshModelsIfChanged(onDone) {
  if (_busy) {
    log.info('openclaw-provider', 'refreshModels: 有操作进行中，跳过');
    if (typeof onDone === 'function') onDone();
    return;
  }

  const configFile = resolveOpenclawConfigFile();
  if (!configFile) {
    if (typeof onDone === 'function') onDone();
    return;
  }

  let config;
  try {
    config = readJsonFile(configFile);
  } catch (e) {
    log.warn('openclaw-provider', `refreshModels: 读取配置失败: ${e.message}`);
    if (typeof onDone === 'function') onDone();
    return;
  }

  const providers = config.models?.providers || {};
  const providerId = Object.keys(providers)[0];
  if (!providerId) {
    log.info('openclaw-provider', 'refreshModels: 未找到已配置的 provider，跳过');
    if (typeof onDone === 'function') onDone();
    return;
  }

  const providerCfg = providers[providerId];
  const baseUrl = providerCfg.baseUrl || '';
  const apiKey = providerCfg.apiKey || '';
  const currentModels = providerCfg.models || [];

  _busy = true;
  fetchModels(baseUrl, apiKey, (err, newModels) => {
    try {
      if (err) {
        log.warn('openclaw-provider', `refreshModels: 拉模型失败: ${err.message}`);
        return;
      }

      const currentMd5 = computeModelsMd5(currentModels);
      const newMd5     = computeModelsMd5(newModels);

      if (currentMd5 === newMd5) {
        log.info('openclaw-provider', `模型列表未变化（${newModels.length} 个），跳过更新`);
        return;
      }

      log.info('openclaw-provider', `模型列表已变化（${currentModels.length} → ${newModels.length} 个），更新 openclaw.json`);
      addProviderSync(configFile, providerId, baseUrl, apiKey, newModels, null);
    } catch (e) {
      log.error('openclaw-provider', `refreshModels: ${e.message}`);
    } finally {
      _busy = false;
      if (typeof onDone === 'function') onDone();
    }
  });
}

module.exports = {
  applyFullProviderFromVps,
  removeProviderByName,
  refreshModelsIfChanged,
  isFullProvider,
  DEFAULT_BASE_URL,
};
