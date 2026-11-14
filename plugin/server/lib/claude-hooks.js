'use strict';

/**
 * Optional Claude Code wiring for quota-aware delegation (`install --usage-hooks`):
 *
 *   statusLine        `dsh-delegate statusline` records the plan quota Claude Code
 *                     reports and shows it in the footer.
 *   UserPromptSubmit  `dsh-delegate hook prompt` reminds Claude to delegate more
 *                     when that quota runs low.
 *
 * Both are shell-form commands (`node "<cli>" ...` with forward slashes): Claude Code
 * runs them through Git Bash or PowerShell on Windows, and that form parses the
 * same in both. Only entries that call our CLI are ever changed or removed; a
 * statusLine the user already has is left alone.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { backup, readJson } = require('./targets');

const OURS = /dsh-delegate\.js"?\s+(statusline|hook\s+prompt)\b/;

function settingsPath() {
  const dir = process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR.trim();
  return path.join(dir || path.join(os.homedir(), '.claude'), 'settings.json');
}

function isOurs(command) {
  return typeof command === 'string' && OURS.test(command);
}

function command(ctx, sub) {
  const node = ctx.nodeOnPath ? 'node' : `"${String(ctx.nodePath).replace(/\\/g, '/')}"`;
  return `${node} "${String(ctx.cliPath).replace(/\\/g, '/')}" ${sub}`;
}

function writeSettings(file, json) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
}

/**
 * @param {{nodePath:string, cliPath:string, nodeOnPath:boolean}} ctx
 * @param {{dryRun?:boolean}} options
 */
function apply(ctx, options = {}) {
  const file = settingsPath();
  const json = fs.existsSync(file) ? readJson(file) : {};
  if (!json) return [{ target: 'claude-hooks', status: 'skipped', file, detail: `${file} 无法解析，未改动` }];
  if (json.hooks !== undefined && (json.hooks === null || typeof json.hooks !== 'object' || Array.isArray(json.hooks))) {
    return [{ target: 'claude-hooks', status: 'skipped', file, detail: 'hooks 结构异常，未改动' }];
  }

  const results = [];
  let changed = false;
  const mark = (target, status, detail) => results.push({ target, status, file, ...(detail ? { detail } : {}) });

  // statusLine: ours, or nothing there yet.
  const statusCommand = command(ctx, 'statusline');
  const current = json.statusLine;
  if (!current) {
    json.statusLine = { type: 'command', command: statusCommand };
    changed = true;
    mark('claude-statusline', 'written');
  } else if (isOurs(current.command)) {
    if (current.command !== statusCommand) {
      json.statusLine = { ...current, command: statusCommand };
      changed = true;
      mark('claude-statusline', 'written');
    } else {
      mark('claude-statusline', 'unchanged');
    }
  } else {
    mark('claude-statusline', 'skipped', '已有自己的 statusLine，未改动；要记录额度，在脚本里把输入转给 dsh-delegate statusline');
  }

  // UserPromptSubmit hook: update ours in place, or append one group.
  const hookCommand = command(ctx, 'hook prompt');
  json.hooks = json.hooks || {};
  const groups = Array.isArray(json.hooks.UserPromptSubmit) ? json.hooks.UserPromptSubmit : [];
  const ours = groups.flatMap((group) => (Array.isArray(group && group.hooks) ? group.hooks : [])).filter((hook) => isOurs(hook && hook.command));
  if (ours.length === 0) {
    groups.push({ hooks: [{ type: 'command', command: hookCommand, timeout: 10 }] });
    json.hooks.UserPromptSubmit = groups;
    changed = true;
    mark('claude-prompt-hook', 'written');
  } else if (ours.some((hook) => hook.command !== hookCommand)) {
    for (const hook of ours) hook.command = hookCommand;
    changed = true;
    mark('claude-prompt-hook', 'written');
  } else {
    mark('claude-prompt-hook', 'unchanged');
  }

  if (options.dryRun) {
    return results.map((item) => (item.status === 'written' ? { ...item, status: 'would-write' } : item));
  }
  if (changed) {
    backup(file);
    writeSettings(file, json);
  }
  return results;
}

/** Remove only what apply() added. */
function remove(options = {}) {
  const file = settingsPath();
  const json = fs.existsSync(file) ? readJson(file) : null;
  if (!json) return [];
  const results = [];
  let changed = false;

  if (json.statusLine && isOurs(json.statusLine.command)) {
    delete json.statusLine;
    changed = true;
    results.push({ target: 'claude-statusline', status: options.dryRun ? 'would-remove' : 'removed', file });
  }

  const groups = json.hooks && Array.isArray(json.hooks.UserPromptSubmit) ? json.hooks.UserPromptSubmit : null;
  if (groups) {
    let removed = 0;
    const kept = [];
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) {
        kept.push(group);
        continue;
      }
      const hooks = group.hooks.filter((hook) => !isOurs(hook && hook.command));
      removed += group.hooks.length - hooks.length;
      if (hooks.length) kept.push({ ...group, hooks });
    }
    if (removed) {
      if (kept.length) json.hooks.UserPromptSubmit = kept;
      else delete json.hooks.UserPromptSubmit;
      if (Object.keys(json.hooks).length === 0) delete json.hooks;
      changed = true;
      results.push({ target: 'claude-prompt-hook', status: options.dryRun ? 'would-remove' : 'removed', file });
    }
  }

  if (changed && !options.dryRun) {
    backup(file);
    writeSettings(file, json);
  }
  return results;
}

module.exports = { apply, remove, settingsPath, isOurs };
