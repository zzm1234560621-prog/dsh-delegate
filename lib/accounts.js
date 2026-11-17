'use strict';

/**
 * 插件内部的账号列表（目前针对 dsh-opencode-go）。
 *
 * 这个插件的「账号」不是 provider，而是插件配置里的 accounts[]：
 *
 *   - id: opencode-go
 *     name: dsh-opencode-go
 *     config:
 *       accounts:
 *         - id: ap
 *           name: "AP"
 *           apiKeyEnv: ap
 *       apiKeyEnv: ap          ← 当前账号（row 级）
 *       autoSwitch: true
 *
 * 看板的「模型供应商」只能列插件，账号得单独展示与切换，否则用户会以为
 * 换不了供应商。
 */

const fs = require('node:fs');
const path = require('node:path');
const { dshHome } = require('./dsh');

const PLUGIN = 'dsh-opencode-go';

function patchFile() {
  return path.join(dshHome(), 'profiles', 'headless', 'cordis.patch.yml');
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** 找到承载账号的那个 row（按 name: dsh-opencode-go 或 id: opencode-go）。 */
function findRow(lines) {
  // 顶层的 row 才以 "- id:" 开头（列 0）；accounts 里的条目是缩进的。
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^-\s+id:\s*\S+\s*$/.test(lines[index])) continue;
    let endIndex = index + 1;
    while (endIndex < lines.length && !/^-\s+id:\s*\S+\s*$/.test(lines[endIndex])) endIndex += 1;
    const block = lines.slice(index, endIndex);
    const name = (block.join('\n').match(/^\s+name:\s*"?([^"\s]+)"?\s*$/m) || [])[1];
    if (name !== PLUGIN) continue;
    const id = (lines[index].match(/id:\s*(\S+)/) || [])[1];
    return { id, start: index, end: endIndex, block };
  }
  return null;
}

function indentOf(line) {
  return line.length - line.replace(/^\s+/, '').length;
}

/** 解析当前配置。 */
function read() {
  const file = patchFile();
  const lines = readText(file).split(/\r?\n/);
  const row = findRow(lines);
  if (!row) {
    return { ok: false, file, error: '没有找到 dsh-opencode-go 的配置块', accounts: [] };
  }

  const block = row.block;
  const accounts = [];
  let current = null;
  let autoSwitch = null;
  let inAccounts = false;
  let accountIndent = 0;

  for (const line of block) {
    const indent = indentOf(line);
    if (/^\s*accounts:\s*$/.test(line)) {
      inAccounts = true;
      accountIndent = indent;
      continue;
    }
    if (inAccounts) {
      if (line.trim() && indent <= accountIndent) inAccounts = false;
      else {
        const id = (line.match(/^\s*-\s+id:\s*(\S+)\s*$/) || [])[1];
        if (id) accounts.push({ id, name: null, env: null });
        else if (accounts.length) {
          const name = (line.match(/^\s+name:\s*"?([^"]*)"?\s*$/) || [])[1];
          const env = (line.match(/^\s+apiKeyEnv:\s*(\S+)\s*$/) || [])[1];
          if (name) accounts[accounts.length - 1].name = name;
          if (env) accounts[accounts.length - 1].env = env;
        }
        continue;
      }
    }
    // row 级的 apiKeyEnv / autoSwitch（缩进比 accounts 浅）
    if (/^\s+apiKeyEnv:\s*\S+\s*$/.test(line) && indent <= accountIndent + 2) {
      current = (line.match(/apiKeyEnv:\s*(\S+)\s*$/) || [])[1];
    }
    if (/^\s+autoSwitch:\s*(true|false)\s*$/i.test(line)) {
      autoSwitch = /true/i.test(line);
    }
  }

  const envFile = readText(path.join(dshHome(), '.env'));
  const hasEnv = (name) =>
    Boolean(name) && (Boolean(process.env[name]) || new RegExp(`^${name}\\s*=`, 'm').test(envFile));

  const enriched = accounts.map((account) => ({
    id: account.id,
    name: account.name || account.id,
    env: account.env,
    hasKey: hasEnv(account.env),
    current: account.env && current ? account.env === current : false,
  }));

  return {
    ok: true,
    file,
    rowId: row.id,
    plugin: PLUGIN,
    current,
    autoSwitch: autoSwitch === null ? true : autoSwitch,
    accounts: enriched,
  };
}

/** 把 row 级的 apiKeyEnv 改成某个账号的环境变量。 */
function switchTo(accountId) {
  const state = read();
  if (!state.ok) throw new Error(state.error);
  const account = state.accounts.find((item) => item.id === accountId);
  if (!account) throw new Error(`没有这个账号：${accountId}`);

  const file = state.file;
  const lines = readText(file).split(/\r?\n/);
  const row = findRow(lines);
  if (!row) throw new Error('配置块在读取后消失了，未改动');

  const block = lines.slice(row.start, row.end);
  const accountsIndent = (block.find((line) => /^\s*accounts:\s*$/.test(line)) || '').search(/\S/);
  let replaced = false;

  for (let index = 0; index < block.length; index += 1) {
    const line = block[index];
    if (!/^\s+apiKeyEnv:\s*\S+\s*$/.test(line)) continue;
    const indent = indentOf(line);
    // accounts 内的条目缩进更深，跳过
    if (accountsIndent >= 0 && indent > accountsIndent) continue;
    block[index] = `${' '.repeat(indent)}apiKeyEnv: ${account.env}`;
    replaced = true;
  }

  if (!replaced) throw new Error('配置块里没有 row 级的 apiKeyEnv，未改动');
  const next = [...lines.slice(0, row.start), ...block, ...lines.slice(row.end)];
  fs.writeFileSync(file, next.join('\n'));
  return read();
}

function setAutoSwitch(enabled) {
  const state = read();
  if (!state.ok) throw new Error(state.error);
  const file = state.file;
  const lines = readText(file).split(/\r?\n/);
  const row = findRow(lines);
  if (!row) throw new Error('配置块在读取后消失了，未改动');

  const block = lines.slice(row.start, row.end);
  const accountsIndent = (block.find((line) => /^\s*accounts:\s*$/.test(line)) || '').search(/\S/);
  let found = false;

  for (let index = 0; index < block.length; index += 1) {
    const line = block[index];
    if (!/^\s+autoSwitch:\s*(true|false)\s*$/i.test(line)) continue;
    const indent = indentOf(line);
    if (accountsIndent >= 0 && indent > accountsIndent) continue;
    block[index] = `${' '.repeat(indent)}autoSwitch: ${enabled ? 'true' : 'false'}`;
    found = true;
  }
  if (!found) {
    // 没有就加在 row 级 apiKeyEnv 之后
    const at = block.findIndex((line) => /^\s+apiKeyEnv:\s*\S+\s*$/.test(line));
    const indent = at >= 0 ? indentOf(block[at]) : 4;
    block.splice(at >= 0 ? at + 1 : block.length, 0, `${' '.repeat(indent)}autoSwitch: ${enabled ? 'true' : 'false'}`);
  }

  const next = [...lines.slice(0, row.start), ...block, ...lines.slice(row.end)];
  fs.writeFileSync(file, next.join('\n'));
  return read();
}

module.exports = { read, switchTo, setAutoSwitch, patchFile };
