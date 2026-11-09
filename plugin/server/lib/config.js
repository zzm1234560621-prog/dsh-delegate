'use strict';

/**
 * Read/write the pieces the local UI manages: the headless profile's model
 * selection and the API keys in $DSH_HOME/.env.
 *
 * Model selection lives in a marked block inside the headless profile patch, so
 * re-running the tool never clobbers hand-written YAML around it.
 */

const fs = require('node:fs');
const path = require('node:path');
const { dshHome } = require('./dsh');

const MODEL_START = '# dsh-delegate:model:start';
const MODEL_END = '# dsh-delegate:model:end';
const REASONING = ['off', 'low', 'medium', 'high'];

const PERMISSION_MODES = ['workspace-write', 'danger-full-access'];
const APPROVAL_POLICIES = ['never', 'ask'];

/** Runtime defaults applied when a tool call does not spell them out. */
const DEFAULT_SETTINGS = {
  permissionMode: 'workspace-write',
  approvalPolicy: 'never',
  softWaitMs: 45_000,
  timeoutMs: 600_000,
  maxConcurrency: 4,
  maxStorageMb: 256,
  daemonPort: 7788,
  daemonUi: true,
  daemonAutostart: false,
};

function settingsFile() {
  return path.join(dshHome(), 'delegate.json');
}

function profileDir() {
  return path.join(dshHome(), 'profiles', 'headless');
}

function patchFile() {
  return path.join(profileDir(), 'cordis.patch.yml');
}

function envFile() {
  return path.join(dshHome(), '.env');
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function installedPlugins() {
  try {
    const pkg = JSON.parse(readText(path.join(profileDir(), 'package.json')) || '{}');
    const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [];
    return { dependencies: Object.keys(pkg.dependencies || {}), bundles };
  } catch {
    return { dependencies: [], bundles: [] };
  }
}

/** Providers we know how to hint about; anything else can still be typed in. */
const PROVIDERS = [
  {
    id: 'deepseek-official',
    label: 'DeepSeek 官方 API（按量计费）',
    plugin: null,
    envKey: 'DEEPSEEK_API_KEY',
    models: ['deepseek-flash', 'deepseek-v4.1-flash', 'deepseek-chat'],
  },
  {
    id: 'dsh-opencode-go',
    label: 'OpenCode Go 网关（订阅/账号）',
    plugin: 'dsh-opencode-go',
    envKey: 'OPENCODE_GO_ACCOUNT_KEY',
    models: ['deepseek-v4.1-flash', 'deepseek-v4.1-pro'],
  },
];

function providerAvailable(provider) {
  if (!provider.plugin) return true;
  const { dependencies, bundles } = installedPlugins();
  return dependencies.includes(provider.plugin) || bundles.includes(provider.plugin);
}

function parseModelBlock(text) {
  const start = text.indexOf(MODEL_START);
  const end = text.indexOf(MODEL_END);
  if (start === -1 || end === -1 || end < start) return null;
  const block = text.slice(start, end);
  const provider = (block.match(/^\s+provider:\s*"?([^"\s]+)"?\s*$/m) || [])[1];
  const model = (block.match(/^\s+model:\s*"?([^"\s]+)"?\s*$/m) || [])[1];
  const effort = (block.match(/^\s+reasoningEffort:\s*"?([^"\s]+)"?\s*$/m) || [])[1];
  return { provider, model, reasoningEffort: effort, managed: true };
}

function readModel() {
  const text = readText(patchFile());
  const managed = parseModelBlock(text);
  if (managed && managed.provider && managed.model) return managed;

  // Fall back to any agent-default-model entry the user wrote themselves.
  const index = text.indexOf('agent-default-model');
  if (index !== -1) {
    const slice = text.slice(index, index + 600);
    const provider = (slice.match(/^\s+provider:\s*"?([^"\s]+)"?\s*$/m) || [])[1];
    const model = (slice.match(/^\s+model:\s*"?([^"\s]+)"?\s*$/m) || [])[1];
    const effort = (slice.match(/^\s+reasoningEffort:\s*"?([^"\s]+)"?\s*$/m) || [])[1];
    if (provider && model) return { provider, model, reasoningEffort: effort, managed: false };
  }
  return { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: null, managed: false };
}

function quote(value) {
  return /^[A-Za-z0-9._-]+$/.test(String(value)) ? String(value) : `"${String(value).replace(/"/g, '\\"')}"`;
}

function renderModelBlock({ provider, model, reasoningEffort }) {
  return [
    MODEL_START,
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    `    provider: ${quote(provider)}`,
    `    model: ${quote(model)}`,
    ...(reasoningEffort ? [`    reasoningEffort: ${quote(reasoningEffort)}`] : []),
    MODEL_END,
  ].join('\n');
}

function writeModel(input) {
  const provider = String(input.provider || '').trim();
  const model = String(input.model || '').trim();
  const effort = input.reasoningEffort ? String(input.reasoningEffort).trim() : '';
  if (!provider || !model) throw new Error('provider 和 model 都不能为空');
  if (effort && !REASONING.includes(effort)) throw new Error(`reasoningEffort 只能是 ${REASONING.join(' / ')}`);

  const file = patchFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = readText(file);
  const block = `${renderModelBlock({ provider, model, reasoningEffort: effort })}\n`;

  let next;
  const start = existing.indexOf(MODEL_START);
  const end = existing.indexOf(MODEL_END);
  if (start !== -1 && end > start) {
    next = `${existing.slice(0, start)}${block}${existing.slice(end + MODEL_END.length).replace(/^\n/, '')}`;
  } else {
    next = `${existing.replace(/\s*$/, '')}${existing.trim().length ? '\n\n' : ''}${block}`;
  }
  fs.writeFileSync(file, next);
  return readModel();
}

function clearModel() {
  const file = patchFile();
  const existing = readText(file);
  const start = existing.indexOf(MODEL_START);
  const end = existing.indexOf(MODEL_END);
  if (start === -1 || end < start) return readModel();
  fs.writeFileSync(file, `${existing.slice(0, start)}${existing.slice(end + MODEL_END.length).replace(/^\n/, '')}`);
  return readModel();
}

function readEnv() {
  const file = envFile();
  const lines = readText(file).split(/\r?\n/).filter(Boolean);
  const keys = [];
  for (const line of lines) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) keys.push({ name: match[1], hasValue: match[2].trim().length > 0, reserved: /^DSH_/i.test(match[1]) });
  }
  return { file, exists: fs.existsSync(file), keys };
}

function writeEnvKey(name, value) {
  const key = String(name || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('变量名只能包含字母、数字、下划线，且不能以数字开头');
  if (/^DSH_/i.test(key)) {
    throw new Error('DSH_ 开头的变量被 DSH 保留为启动环境变量，不能写进 .env；换个名字（例如 OPENCODE_GO_ACCOUNT_KEY）');
  }
  const text = value === undefined || value === null ? '' : String(value);
  if (text.trim().length === 0) throw new Error('值不能为空');

  const file = envFile();
  const lines = readText(file).split(/\r?\n/);
  let replaced = false;
  const next = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      replaced = true;
      return `${key}=${text}`;
    }
    return line;
  });
  if (!replaced) {
    while (next.length && next[next.length - 1] === '') next.pop();
    next.push(`${key}=${text}`, '');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next.join('\n'));
  return readEnv();
}

function sanitizeSettings(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  if (PERMISSION_MODES.includes(input.permissionMode)) out.permissionMode = input.permissionMode;
  if (APPROVAL_POLICIES.includes(input.approvalPolicy)) out.approvalPolicy = input.approvalPolicy;
  if (Number.isFinite(input.softWaitMs)) out.softWaitMs = Math.min(Math.max(Math.floor(input.softWaitMs), 1_000), 150_000);
  if (Number.isFinite(input.timeoutMs)) out.timeoutMs = Math.min(Math.max(Math.floor(input.timeoutMs), 30_000), 1_800_000);
  if (Number.isFinite(input.maxConcurrency)) out.maxConcurrency = Math.min(Math.max(Math.floor(input.maxConcurrency), 1), 8);
  if (Number.isFinite(input.maxStorageMb)) out.maxStorageMb = Math.min(Math.max(Math.floor(input.maxStorageMb), 1), 20480);
  if (Number.isFinite(input.daemonPort)) out.daemonPort = Math.min(Math.max(Math.floor(input.daemonPort), 1024), 65535);
  if (typeof input.daemonUi === 'boolean') out.daemonUi = input.daemonUi;
  if (typeof input.daemonAutostart === 'boolean') out.daemonAutostart = input.daemonAutostart;
  return out;
}

function readSettingsFile() {
  try {
    return sanitizeSettings(JSON.parse(readText(settingsFile()) || '{}'));
  } catch {
    return {};
  }
}

/**
 * Effective defaults: settings file ← environment overrides.
 * The MCP server reads this on every call, so UI changes apply without a restart.
 */
function readSettings() {
  const merged = { ...DEFAULT_SETTINGS, ...readSettingsFile() };
  if (PERMISSION_MODES.includes(process.env.DSH_DELEGATE_PERMISSION_MODE)) {
    merged.permissionMode = process.env.DSH_DELEGATE_PERMISSION_MODE;
  }
  if (APPROVAL_POLICIES.includes(process.env.DSH_DELEGATE_APPROVAL_POLICY)) {
    merged.approvalPolicy = process.env.DSH_DELEGATE_APPROVAL_POLICY;
  }
  return merged;
}

function writeSettings(patch) {
  const next = { ...DEFAULT_SETTINGS, ...readSettingsFile(), ...sanitizeSettings(patch) };
  const file = settingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return readSettings();
}

function state() {
  const model = readModel();
  const env = readEnv();
  const plugins = installedPlugins();
  return {
    dshHome: dshHome(),
    profileDir: profileDir(),
    patchFile: patchFile(),
    env,
    model,
    settings: readSettings(),
    settingsFile: settingsFile(),
    providers: PROVIDERS.map((provider) => ({
      id: provider.id,
      label: provider.label,
      plugin: provider.plugin,
      available: providerAvailable(provider),
      envKey: provider.envKey,
      models: provider.models,
      hasCredential: env.keys.some((key) => key.name === provider.envKey && key.hasValue),
    })),
    reasoning: REASONING,
    permissionModes: PERMISSION_MODES,
    approvalPolicies: APPROVAL_POLICIES,
    defaultSettings: DEFAULT_SETTINGS,
    plugins,
  };
}

module.exports = {
  state,
  readModel,
  writeModel,
  clearModel,
  readEnv,
  writeEnvKey,
  readSettings,
  writeSettings,
  installProvider,
  PROVIDERS,
  REASONING,
  PERMISSION_MODES,
  APPROVAL_POLICIES,
  DEFAULT_SETTINGS,
};

/** Install a provider plugin into the headless profile (network + pnpm). */
async function installProvider(id) {
  const provider = PROVIDERS.find((item) => item.id === id);
  if (!provider || !provider.plugin) throw new Error(`未知供应商：${id}`);
  const { execFileSync } = require('node:child_process');
  const { which } = require('./dsh');
  const shim = which('dsh');
  if (!shim) throw new Error('找不到 dsh 命令，无法安装供应商插件');
  const output = execFileSync(shim, ['plugin', '--profile', 'headless', 'add', provider.plugin], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  return { ok: true, output: output.slice(-2000) };
}
