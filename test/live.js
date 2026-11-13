#!/usr/bin/env node
'use strict';

/**
 * End-to-end simulation of Claude's side of the protocol:
 * read the config Claude Desktop actually uses, spawn exactly that command, then
 * run the same sequence a client does (initialize → tools/list → tools/call).
 *
 *   node test/live.js            # uses the real Claude Desktop config if present
 *   node test/live.js <config>   # or an explicit claude_desktop_config.json
 *
 * Costs one model call (roughly 10-30s).
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function findConfig(explicit) {
  if (explicit) return explicit;
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dataRoot = path.join(local, 'Claude-Data');
  if (fs.existsSync(dataRoot)) {
    for (const entry of fs.readdirSync(dataRoot)) {
      const file = path.join(dataRoot, entry, 'claude_desktop_config.json');
      if (fs.existsSync(file)) return file;
    }
  }
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(roaming, 'Claude', 'claude_desktop_config.json');
}

function fail(message) {
  console.error('✗ ' + message);
  process.exit(1);
}

const configFile = findConfig(process.argv[2]);
if (!fs.existsSync(configFile)) fail('找不到 Claude 配置：' + configFile);
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const entry = config.mcpServers && config.mcpServers.dsh;
if (!entry) fail('配置里没有 mcpServers.dsh');
console.log('配置:', configFile);
console.log('命令:', entry.command, entry.args.join(' '));

const child = spawn(entry.command, entry.args, {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ...(entry.env || {}) },
});

let buffer = '';
const pending = new Map();
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      try {
        const message = JSON.parse(line);
        if (message.id && pending.has(message.id)) {
          pending.get(message.id)(message);
          pending.delete(message.id);
        }
      } catch {
        /* ignore */
      }
    }
    index = buffer.indexOf('\n');
  }
});
child.stderr.on('data', (chunk) => process.stderr.write('[server] ' + chunk));

let seq = 0;
function send(method, params) {
  const id = (seq += 1);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout: ' + method)), 180_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

(async () => {
  const started = Date.now();
  const init = await send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'claude-ai', version: '1.0.0' },
  });
  console.log('✓ initialize:', init.serverInfo.name, init.serverInfo.version);

  const list = await send('tools/list', {});
  console.log('✓ tools:', list.tools.map((tool) => tool.name).join(', '));
  if (list.tools.length !== 3) fail('工具数量不是 3');

  const callStarted = Date.now();
  const result = await send('tools/call', {
    name: 'dsh_task',
    arguments: { task: '只回复一个数字：7', soft_wait_ms: 120000 },
  });
  const text = result.content[0].text;
  console.log(`\n[dsh_task ${Math.round((Date.now() - callStarted) / 1000)}s]`);
  console.log(text.split('\n').slice(0, 3).join('\n'));

  if (!/DSH ok/.test(text)) fail('调用没有成功');
  if (!/\b7\b/.test(text)) fail('结果里没有 7');
  console.log(`\n✓ 端到端通过（总计 ${Math.round((Date.now() - started) / 1000)}s）`);
  child.kill();
  process.exit(0);
})().catch((error) => {
  fail(error.message);
});
