'use strict';

/**
 * Client targets: where each host stores MCP server config,
 * and how to add/remove the dsh server there.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { which, exists } = require('./dsh');

const SERVER_NAME = 'dsh';

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

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
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

function mcpEntry(ctx) {
  return {
    command: ctx.nodePath,
    args: [ctx.mcpPath],
    env: { DSH_HOME: ctx.dshHome },
  };
}

function applyClaudeDesktop(ctx, options) {
  const files = claudeDesktopConfigs();
  if (files.length === 0) {
    return {
      target: 'claude-desktop',
      status: 'skipped',
      detail: '没找到 Claude 桌面版配置；先启动一次 Claude 桌面版，或用 Claude Code CLI。',
    };
  }
  const file = files[0];
  const json = readJson(file);
  if (!json) return { target: 'claude-desktop', status: 'error', detail: `无法解析 ${file}` };
  json.mcpServers = json.mcpServers || {};
  json.mcpServers[SERVER_NAME] = mcpEntry(ctx);
  if (options.dryRun) {
    return { target: 'claude-desktop', status: 'would-write', file, detail: `mcpServers.${SERVER_NAME}` };
  }
  backup(file);
  writeJson(file, json);
  return {
    target: 'claude-desktop',
    status: 'written',
    file,
    detail: `mcpServers.${SERVER_NAME} → node ${ctx.mcpPath}（重启 Claude 桌面版生效）`,
  };
}

function applyClaudeCode(ctx, options) {
  const cli = which('claude');
  if (cli) {
    if (options.dryRun) {
      return { target: 'claude-code', status: 'would-run', detail: `${cli} mcp add --scope user ${SERVER_NAME}` };
    }
    // Windows ships claude as a .cmd shim; spawning it needs a shell.
    const needsShell = /\.(cmd|bat)$/i.test(cli);
    spawnSync(cli, ['mcp', 'remove', SERVER_NAME, '--scope', 'user'], { stdio: 'ignore', shell: needsShell });
    const result = spawnSync(cli, ['mcp', 'add', '--scope', 'user', SERVER_NAME, '--', ctx.nodePath, ctx.mcpPath], {
      encoding: 'utf8',
      shell: needsShell,
    });
    if (result.status === 0) {
      return { target: 'claude-code', status: 'written', detail: `claude mcp add --scope user ${SERVER_NAME}` };
    }
    // fall through to config editing when the CLI refuses
  }

  const file = path.join(home(), '.claude.json');
  // A fresh machine has no ~/.claude.json yet; create it instead of skipping.
  const json = readJson(file) || {};
  if (json.mcpServers !== undefined && typeof json.mcpServers !== 'object') {
    return { target: 'claude-code', status: 'skipped', detail: '~/.claude.json 结构异常，未改动' };
  }
  json.mcpServers = json.mcpServers || {};
  json.mcpServers[SERVER_NAME] = mcpEntry(ctx);
  if (options.dryRun) return { target: 'claude-code', status: 'would-write', file, detail: `mcpServers.${SERVER_NAME}` };
  backup(file);
  writeJson(file, json);
  return { target: 'claude-code', status: 'written', file, detail: `~/.claude.json mcpServers.${SERVER_NAME}` };
}

function codexConfigPath() {
  const root = process.env.CODEX_HOME || path.join(home(), '.codex');
  return path.join(root, 'config.toml');
}

function tomlString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function applyCodex(ctx, options) {
  const cli = which('codex');
  const file = codexConfigPath();
  if (cli && !fs.existsSync(file)) {
    if (options.dryRun) return { target: 'codex', status: 'would-run', detail: `${cli} mcp add ${SERVER_NAME}` };
    const result = spawnSync(cli, ['mcp', 'add', SERVER_NAME, '--', ctx.nodePath, ctx.mcpPath], { encoding: 'utf8' });
    if (result.status === 0) {
      return { target: 'codex', status: 'written', detail: `codex mcp add ${SERVER_NAME}` };
    }
  }

  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const block = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${tomlString(ctx.nodePath)}`,
    `args = [${tomlString(ctx.mcpPath)}]`,
    `env = { DSH_HOME = ${tomlString(ctx.dshHome)} }`,
    '',
  ].join('\n');

  if (new RegExp(`\\[mcp_servers\\.${SERVER_NAME}\\]`).test(existing)) {
    return { target: 'codex', status: 'present', file, detail: `[mcp_servers.${SERVER_NAME}] 已存在，未改动` };
  }
  if (options.dryRun) return { target: 'codex', status: 'would-write', file, detail: `[mcp_servers.${SERVER_NAME}]` };

  backup(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const prefix = existing.trim().length ? `${existing.replace(/\s*$/, '')}\n\n` : '';
  fs.writeFileSync(file, `${prefix}${block}`);
  return { target: 'codex', status: 'written', file, detail: `[mcp_servers.${SERVER_NAME}]` };
}

function applyAll(targets, ctx, options) {
  const results = [];
  for (const target of targets) {
    if (target === 'claude-desktop') results.push(applyClaudeDesktop(ctx, options));
    else if (target === 'claude-code') results.push(applyClaudeCode(ctx, options));
    else if (target === 'codex') results.push(applyCodex(ctx, options));
    else results.push({ target, status: 'unknown', detail: '未知目标（可选 claude-desktop / claude-code / codex）' });
  }
  return results;
}

/** Remove our server entry from every client we can find. */
function removeAll(entries) {
  const results = [];
  for (const [target, file] of entries) {
    const json = readJson(file);
    if (!json || !json.mcpServers || !json.mcpServers[SERVER_NAME]) continue;
    delete json.mcpServers[SERVER_NAME];
    backup(file);
    writeJson(file, json);
    results.push({ target, status: 'removed', file });
  }
  return results;
}

module.exports = {
  SERVER_NAME,
  claudeDesktopConfigs,
  applyAll,
  removeAll,
  codexConfigPath,
};
