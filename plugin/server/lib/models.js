'use strict';

/**
 * Live model catalogs, so the dashboard lists what the providers actually offer
 * instead of a hard-coded guess.
 */

const { getJson } = require('./net');
const { dshHome } = require('./dsh');

const CACHE_MS = 10 * 60 * 1000;
let cache = { at: 0, data: null };

function envValue(name) {
  if (process.env[name]) return process.env[name];
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const text = fs.readFileSync(path.join(dshHome(), '.env'), 'utf8');
    const match = text.match(new RegExp(`^${name}=(.*)$`, 'm'));
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

const CATALOGS = [
  {
    provider: 'deepseek-official',
    url: 'https://api.deepseek.com/models',
    keyEnv: 'DEEPSEEK_API_KEY',
    auth: (key) => ({ authorization: `Bearer ${key}` }),
    parse: (json) => (json.data || []).map((item) => item.id).filter(Boolean),
  },
  {
    provider: 'dsh-opencode-go',
    url: 'https://opencode.ai/inference/go/v1/models',
    keyEnv: 'OPENCODE_GO_ACCOUNT_KEY',
    auth: (key) => ({ authorization: `Bearer ${key}` }),
    parse: (json) => (json.data || []).map((item) => item.id).filter(Boolean),
  },
];

async function load(force = false) {
  if (!force && cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;

  const result = { at: Date.now(), providers: {}, errors: {} };
  await Promise.all(
    CATALOGS.map(async (catalog) => {
      const key = envValue(catalog.keyEnv);
      if (!key) {
        result.errors[catalog.provider] = `缺少 ${catalog.keyEnv}`;
        return;
      }
      try {
        const json = await getJson(catalog.url, catalog.auth(key), 8000);
        result.providers[catalog.provider] = catalog.parse(json);
      } catch (cause) {
        result.errors[catalog.provider] = cause && cause.message ? cause.message : String(cause);
      }
    }),
  );
  cache = { at: result.at, data: result };
  return result;
}

module.exports = { load };
