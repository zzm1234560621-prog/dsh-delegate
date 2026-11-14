'use strict';

/**
 * Client targets: where each host stores MCP server config,
 * and how to add/remove the dsh server there.
 *
 * Applying is idempotent: an entry that already starts the right node + mcp.js is
 * left alone (no rewrite, no backup, no CLI call). That matters because the DSH
 * plugin re-applies this on every profile start.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { which, spawnSyncCommand } = require('./dsh');

const SERVER_NAME = 'dsh';
const ALL_TARGETS = ['claude-desktop', 'claude-code', 'codex'];

function home() {
  return os.homedir();
}

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = `${file}.bak-dsh-delegate-${stamp}`;
  fs.copyFileSync(file, target);
  return target;
}

/** Parsed object, {} for an empty file, or null when the file is not a JSON object. */
function readJson(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (text.trim() === '') return {};
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function badServers(json) {
  return json.mcpServers !== undefined && (json.mcpServers === null || typeof json.mcpServers !== 'object');
}

/** Claude Desktop config locations, most specific first. */
function claudeDesktopConfigs() {
  const found = [];
  const add = (file) => {
    if (file && fs.existsSync(file)) found.push(file);
  };

  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home(), 'AppData', 'Local');
    const roaming = process.env.APPDATA || path.join(home(), 'AppData', 'Roaming');
    // Microsoft Store build keeps its profile outside the package.
    const dataRoot = path.join(local, 'Claude-Data');
    if (fs.existsSync(dataRoot)) {
      for (const entry of fs.readdirSync(dataRoot)) {
        if (entry.startsWith('claude_')) add(path.join(dataRoot, entry, 'claude_desktop_config.json'));
      }
    }
    const packages = path.join(local, 'Packages');
    if (fs.existsSync(packages)) {
      for (const entry of fs.readdirSync(packages)) {
        if (/^Claude_/i.test(entry)) {
          add(path.join(packages, entry, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'));
        }
      }
    }
    add(path.join(roaming, 'Claude', 'claude_desktop_config.json'));
  } else if (process.platform === 'darwin') {
    add(path.join(home(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
  } else {
    add(path.join(home(), '.config', 'Claude', 'claude_desktop_config.json'));
  }
  return [...new Set(found)];
}

/** Claude Code keeps user-scope MCP servers in ~/.claude.json (or under CLAUDE_CONFIG_DIR). */
function claudeCodeConfigPath() {
  const dir = process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR.trim();
  return path.join(dir || home(), '.claude.json');
}

function codexConfigPath() {
  const root = process.env.CODEX_HOME || path.join(home(), '.codex');
  return path.join(root, 'config.toml');
}

function mcpEntry(ctx) {
  return {
    command: ctx.nodePath,
    args: [ctx.mcpPath],
    env: { DSH_HOME: ctx.dshHome },
  };
}

/** Does an existing entry already start the same server? (`type` and other keys are ignored.) */
function sameEntry(current, desired) {
  if (!current || typeof current !== 'object') return false;
  if (current.command !== desired.command) return false;
  const args = Array.isArray(current.args) ? current.args : [];
  if (args.length !== desired.args.length || args.some((value, index) => value !== desired.args[index])) return false;
  const dshHome = current.env && current.env.DSH_HOME;
  return !dshHome || dshHome === desired.env.DSH_HOME;
}

/** Ours = it starts a dsh-delegate mcp.js. Someone else's server named "dsh" is never removed. */
function isOurEntry(entry) {
  return Boolean(
    entry && Array.isArray(entry.args) && entry.args.some((arg) => /[\\/]lib[\\/]mcp\.js$/.test(String(arg))),
  );
}

// ---------------------------------------------------------------- Claude Desktop

function applyClaudeDesktop(ctx, options) {
  const files = claudeDesktopConfigs();
  if (files.length === 0) {
    return [
      {
        target: 'claude-desktop',
        status: 'skipped',
        detail: '没找到 Claude 桌面版配置；先启动一次 Claude 桌面版，或用 Claude Code CLI。',
      },
    ];
  }
  const desired = mcpEntry(ctx);
  return files.map((file) => {
    const json = readJson(file);
    if (!json || badServers(json)) {
      return { target: 'claude-desktop', status: 'error', file, detail: `无法解析 ${file}，未改动` };
    }
    if (json.mcpServers && sameEntry(json.mcpServers[SERVER_NAME], desired)) {
      return { target: 'claude-desktop', status: 'unchanged', file, detail: `mcpServers.${SERVER_NAME} 已是最新` };
    }
    if (options.dryRun) {
      return { target: 'claude-desktop', status: 'would-write', file, detail: `mcpServers.${SERVER_NAME}` };
    }
    json.mcpServers = json.mcpServers || {};
    json.mcpServers[SERVER_NAME] = desired;
    backup(file);
    writeJson(file, json);
    return {
      target: 'claude-desktop',
      status: 'written',
      file,
      detail: `mcpServers.${SERVER_NAME} → node ${ctx.mcpPath}（重启 Claude 桌面版生效）`,
    };
  });
}

function removeClaudeDesktop(options) {
  const results = [];
  for (const file of claudeDesktopConfigs()) {
    const json = readJson(file);
    if (!json || !json.mcpServers || !isOurEntry(json.mcpServers[SERVER_NAME])) continue;
    if (options.dryRun) {
      results.push({ target: 'claude-desktop', status: 'would-remove', file });
      continue;
    }
    delete json.mcpServers[SERVER_NAME];
    backup(file);
    writeJson(file, json);
    results.push({ target: 'claude-desktop', status: 'removed', file });
  }
  return results;
}

// ---------------------------------------------------------------- Claude Code

function claudeCli(cli, args) {
  return spawnSyncCommand(cli, args, { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
}

function applyClaudeCode(ctx, options) {
  // Check the config before touching it: the `claude` CLI would happily rewrite a
  // corrupt ~/.claude.json and take the user's settings with it.
  const file = claudeCodeConfigPath();
  const json = fs.existsSync(file) ? readJson(file) : {};
  if (!json) {
    return {
      target: 'claude-code',
      status: 'skipped',
      file,
      detail: `${file} 无法解析，未改动（请自行修复或备份后删除该文件）`,
    };
  }
  if (badServers(json)) {
    return { target: 'claude-code', status: 'skipped', file, detail: `${file} 的 mcpServers 结构异常，未改动` };
  }
  const desired = mcpEntry(ctx);
  if (json.mcpServers && sameEntry(json.mcpServers[SERVER_NAME], desired)) {
    return { target: 'claude-code', status: 'unchanged', file, detail: `mcpServers.${SERVER_NAME} 已是最新` };
  }

  // Prefer the CLI: a running Claude Code rewrites this file itself.
  const cli = which('claude');
  if (cli) {
    if (options.dryRun) {
      return { target: 'claude-code', status: 'would-run', detail: `${cli} mcp add --scope user ${SERVER_NAME}` };
    }
    claudeCli(cli, ['mcp', 'remove', SERVER_NAME, '--scope', 'user']);
    const result = claudeCli(cli, [
      'mcp', 'add', '--scope', 'user', SERVER_NAME,
      '-e', `DSH_HOME=${ctx.dshHome}`,
      '--', ctx.nodePath, ctx.mcpPath,
    ]);
    const after = fs.existsSync(file) ? readJson(file) : null;
    if (result.status === 0 && after && after.mcpServers && sameEntry(after.mcpServers[SERVER_NAME], desired)) {
      return { target: 'claude-code', status: 'written', file, detail: `claude mcp add --scope user ${SERVER_NAME}` };
    }
    // fall through to editing the file when the CLI refuses or wrote something unexpected
  }

  // No CLI (or it failed): edit the file. A missing file means a fresh machine — create it.
  const fresh = fs.existsSync(file) ? readJson(file) : {};
  if (!fresh || badServers(fresh)) {
    return { target: 'claude-code', status: 'skipped', file, detail: `${file} 无法解析，未改动` };
  }
  if (options.dryRun) return { target: 'claude-code', status: 'would-write', file, detail: `mcpServers.${SERVER_NAME}` };
  fresh.mcpServers = fresh.mcpServers || {};
  fresh.mcpServers[SERVER_NAME] = desired;
  backup(file);
  writeJson(file, fresh);
  return { target: 'claude-code', status: 'written', file, detail: `${file} mcpServers.${SERVER_NAME}` };
}

function removeClaudeCode(options) {
  const file = claudeCodeConfigPath();
  const json = fs.existsSync(file) ? readJson(file) : null;
  if (!json || !json.mcpServers || !isOurEntry(json.mcpServers[SERVER_NAME])) return [];
  if (options.dryRun) return [{ target: 'claude-code', status: 'would-remove', file }];

  const cli = which('claude');
  if (cli) {
    claudeCli(cli, ['mcp', 'remove', SERVER_NAME, '--scope', 'user']);
    const after = readJson(file);
    if (after && !(after.mcpServers && after.mcpServers[SERVER_NAME])) {
      return [{ target: 'claude-code', status: 'removed', file, detail: `claude mcp remove ${SERVER_NAME}` }];
    }
  }
  const fresh = readJson(file);
  if (!fresh || !fresh.mcpServers) return [];
  delete fresh.mcpServers[SERVER_NAME];
  backup(file);
  writeJson(file, fresh);
  return [{ target: 'claude-code', status: 'removed', file }];
}

// ---------------------------------------------------------------- Codex

function tomlString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function codexBlock(ctx) {
  return [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${tomlString(ctx.nodePath)}`,
    `args = [${tomlString(ctx.mcpPath)}]`,
    `env = { DSH_HOME = ${tomlString(ctx.dshHome)} }`,
  ];
}

/** Line range of `[mcp_servers.dsh]` plus any `[mcp_servers.dsh.*]` sub-tables, or null. */
function findCodexBlock(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*\[\s*mcp_servers\.dsh\s*\]\s*(#.*)?$/.test(line));
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !(/^\s*\[/.test(lines[end]) && !/^\s*\[\s*mcp_servers\.dsh\./.test(lines[end]))) {
    end += 1;
  }
  while (end > start + 1 && lines[end - 1].trim() === '') end -= 1;
  return { lines, start, end };
}

/** Only command/args/env on single lines: the shape we (or `codex mcp add`) write. */
function isPlainCodexBlock(block) {
  return block.lines
    .slice(block.start + 1, block.end)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .every((line) => /^(command|args|env)\s*=/.test(line));
}

function applyCodex(ctx, options) {
  const file = codexConfigPath();
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const wanted = codexBlock(ctx);
  const block = findCodexBlock(existing);

  if (block) {
    const current = block.lines.slice(block.start, block.end).map((line) => line.trim());
    if (current.join('\n') === wanted.join('\n')) {
      return { target: 'codex', status: 'unchanged', file, detail: `[mcp_servers.${SERVER_NAME}] 已是最新` };
    }
    if (!isPlainCodexBlock(block)) {
      return { target: 'codex', status: 'present', file, detail: `[mcp_servers.${SERVER_NAME}] 有自定义内容，未改动` };
    }
    if (options.dryRun) return { target: 'codex', status: 'would-write', file, detail: `更新 [mcp_servers.${SERVER_NAME}]` };
    backup(file);
    const next = [...block.lines.slice(0, block.start), ...wanted, ...block.lines.slice(block.end)].join(eol);
    fs.writeFileSync(file, next);
    return { target: 'codex', status: 'written', file, detail: `[mcp_servers.${SERVER_NAME}] 已更新` };
  }

  if (options.dryRun) return { target: 'codex', status: 'would-write', file, detail: `[mcp_servers.${SERVER_NAME}]` };
  backup(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const prefix = existing.trim().length ? `${existing.replace(/\s*$/, '')}${eol}${eol}` : '';
  fs.writeFileSync(file, `${prefix}${wanted.join(eol)}${eol}`);
  return { target: 'codex', status: 'written', file, detail: `[mcp_servers.${SERVER_NAME}]` };
}

function removeCodex(options) {
  const file = codexConfigPath();
  if (!fs.existsSync(file)) return [];
  const existing = fs.readFileSync(file, 'utf8');
  const block = findCodexBlock(existing);
  if (!block) return [];
  const body = block.lines.slice(block.start, block.end).join('\n');
  if (!isPlainCodexBlock(block) || !/[\\/]lib[\\/]mcp\.js"/.test(body.replace(/\\\\/g, '\\'))) {
    return [{ target: 'codex', status: 'kept', file, detail: `[mcp_servers.${SERVER_NAME}] 不是本工具写的，未删除` }];
  }
  if (options.dryRun) return [{ target: 'codex', status: 'would-remove', file }];
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const next = [...block.lines.slice(0, block.start), ...block.lines.slice(block.end)]
    .join(eol)
    .replace(/(\r?\n){3,}/g, `${eol}${eol}`);
  backup(file);
  fs.writeFileSync(file, next);
  return [{ target: 'codex', status: 'removed', file }];
}

// ---------------------------------------------------------------- all

function applyAll(targets, ctx, options) {
  const results = [];
  for (const target of targets) {
    if (target === 'claude-desktop') results.push(...applyClaudeDesktop(ctx, options));
    else if (target === 'claude-code') results.push(applyClaudeCode(ctx, options));
    else if (target === 'codex') results.push(applyCodex(ctx, options));
    else results.push({ target, status: 'unknown', detail: '未知目标（可选 claude-desktop / claude-code / codex）' });
  }
  return results;
}

/** Remove our server entry from every client that has it. */
function removeAll(targets = ALL_TARGETS, options = {}) {
  const results = [];
  for (const target of targets) {
    if (target === 'claude-desktop') results.push(...removeClaudeDesktop(options));
    else if (target === 'claude-code') results.push(...removeClaudeCode(options));
    else if (target === 'codex') results.push(...removeCodex(options));
  }
  return results;
}

module.exports = {
  SERVER_NAME,
  ALL_TARGETS,
  claudeDesktopConfigs,
  claudeCodeConfigPath,
  codexConfigPath,
  applyAll,
  removeAll,
  sameEntry,
  codexBlock,
  backup,
  readJson,
};
