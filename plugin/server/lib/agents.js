'use strict';

/**
 * Install the parts that are not MCP: launcher shim, user-level instruction
 * block, and the dsh-delegate skill for DSH and Claude Code.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isGeneratedShim } = require('./dsh');

const START = '<!-- dsh-delegate:start -->';
const END = '<!-- dsh-delegate:end -->';
const SKILL_NAME = 'dsh-delegate';

function assetsDir() {
  return path.join(__dirname, '..', 'assets');
}

function readAsset(name) {
  return fs.readFileSync(path.join(assetsDir(), name), 'utf8');
}

/**
 * Replace the marked block, or append it when missing. The block is written in the
 * file's own line-ending style and compared ignoring line endings, so installing
 * from checkouts with different EOL settings never rewrites the user's file.
 */
function upsertBlock(file, fragment) {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const body = fragment.replace(/\r\n/g, '\n').trim().split('\n').join(eol);
  const block = `${START}${eol}${body}${eol}${END}${eol}`;
  const pattern = new RegExp(`${START}[\\s\\S]*?${END}(\\r?\\n)?`);
  // A replacer function: the fragment contains `$` (PowerShell), which a
  // replacement string would treat as a pattern.
  const next = pattern.test(existing)
    ? existing.replace(pattern, () => block)
    : `${existing.replace(/\s*$/, existing.trim().length ? `${eol}${eol}` : '')}${block}`;
  const same = (a, b) => a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');
  if (same(next, existing)) return { file, status: 'unchanged' };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  return { file, status: 'written' };
}

function removeBlock(file) {
  if (!fs.existsSync(file)) return { file, status: 'absent' };
  const existing = fs.readFileSync(file, 'utf8');
  const pattern = new RegExp(`\\n?${START}[\\s\\S]*?${END}\\n?`, 'g');
  if (!pattern.test(existing)) return { file, status: 'absent' };
  const next = existing.replace(pattern, '\n').replace(/\n{3,}/g, '\n\n');
  fs.writeFileSync(file, next);
  return { file, status: 'removed' };
}

function shimTarget() {
  if (process.platform === 'win32') {
    const npmBin = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm');
    if (fs.existsSync(npmBin)) return path.join(npmBin, 'dsh.cmd');
    return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'bin', 'dsh.cmd');
  }
  return path.join(os.homedir(), '.local', 'bin', 'dsh');
}

function shimContent(launch, dshHome, platform = process.platform) {
  if (platform !== 'win32') {
    const lines = ['#!/bin/sh', '# dsh-delegate shim (generated; do not edit)', `export DSH_HOME=${quote(dshHome)}`];
    // The CLI a Mac app ships runs on the Node next to it.
    if (launch.nodeDirs && launch.nodeDirs.length) {
      lines.push(`export PATH=${quote(launch.nodeDirs.join(':'))}"\${PATH:+:$PATH}"`);
    }
    lines.push(
      launch.kind === 'desktop'
        ? `ELECTRON_RUN_AS_NODE=1 exec ${quote(launch.command)} --expose-internals ${quote(launch.argsPrefix[1])} "$@"`
        : `exec ${quote(launch.command)} "$@"`,
    );
    return [...lines, ''].join('\n');
  }
  const lines = [
    '@echo off',
    'rem dsh-delegate shim (generated; do not edit)',
    'setlocal DisableDelayedExpansion',
    `if not defined DSH_HOME set "DSH_HOME=${dshHome}"`,
  ];
  if (launch.kind === 'desktop') {
    lines.push('set "ELECTRON_RUN_AS_NODE=1"');
    lines.push(`"${launch.command}" --expose-internals "${launch.argsPrefix[1]}" %*`);
  } else {
    lines.push(`"${launch.command}" %*`);
  }
  lines.push('exit /b %errorlevel%', '');
  return lines.join('\r\n');
}

function quote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function installShim(launch, dshHome, options) {
  // The launcher exists so app-only installs get a `dsh` command: the desktop app, or
  // the CLI a Mac app keeps inside its bundle. When a real CLI is already installed
  // (npm i -g @deepseek-ai/dsh), writing one would shadow it — on Windows it would
  // even replace npm's own dsh.cmd with a file that calls itself.
  if (launch.kind === 'cli' && !launch.bundled) {
    return { file: launch.command, status: 'skipped', detail: `已有 dsh 命令：${launch.command}` };
  }
  const file = shimTarget();
  if (fs.existsSync(file) && !isGeneratedShim(file)) {
    return { file, status: 'skipped', detail: `${file} 已是别的程序，未覆盖` };
  }
  const content = shimContent(launch, dshHome);
  if (options.dryRun) return { file, status: 'would-write' };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o755);
  return { file, status: 'written' };
}

function removeShim() {
  const file = shimTarget();
  if (!fs.existsSync(file)) return { file, status: 'absent' };
  if (!isGeneratedShim(file)) return { file, status: 'kept', detail: '不是 dsh-delegate 生成的，未删除' };
  fs.unlinkSync(file);
  return { file, status: 'removed' };
}

function skillDirs(dshHome) {
  return [
    path.join(dshHome, 'skills', SKILL_NAME),
    path.join(os.homedir(), '.claude', 'skills', SKILL_NAME),
  ];
}

function installSkill(dshHome, options) {
  const source = readAsset('SKILL.md');
  const results = [];
  for (const dir of skillDirs(dshHome)) {
    const file = path.join(dir, 'SKILL.md');
    if (options.dryRun) {
      results.push({ file, status: 'would-write' });
      continue;
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, source);
    results.push({ file, status: 'written' });
  }
  return results;
}

function removeSkill(dshHome) {
  return skillDirs(dshHome)
    .filter((dir) => fs.existsSync(dir))
    .map((dir) => {
      fs.rmSync(dir, { recursive: true, force: true });
      return { file: dir, status: 'removed' };
    });
}

function instructionFiles(dshHome) {
  return [path.join(dshHome, 'AGENTS.md'), path.join(os.homedir(), '.claude', 'CLAUDE.md')];
}

function installInstructions(dshHome, options) {
  const fragment = readAsset('agents-fragment.md');
  const results = [];
  for (const file of instructionFiles(dshHome)) {
    if (options.dryRun) {
      results.push({ file, status: 'would-write' });
      continue;
    }
    results.push(upsertBlock(file, fragment));
  }
  return results;
}

function removeInstructions(dshHome) {
  return instructionFiles(dshHome).map((file) => removeBlock(file));
}

module.exports = {
  installShim,
  shimContent,
  removeShim,
  installSkill,
  removeSkill,
  installInstructions,
  removeInstructions,
  shimTarget,
  upsertBlock,
  removeBlock,
  START,
  END,
};
