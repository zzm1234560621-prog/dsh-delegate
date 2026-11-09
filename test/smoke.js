#!/usr/bin/env node
'use strict';

/**
 * Smoke test: start the MCP server, handshake, list tools.
 * `--run` additionally dispatches one live task (costs a model call, ~10-40s).
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

// Spawn the same file the client configs point at, so a broken entry point fails CI.
const serverPath = path.join(__dirname, '..', 'lib', 'mcp.js');
const live = process.argv.includes('--run');


const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });

let buffer = '';
let nextId = 1;
const pending = new Map();

child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      const message = JSON.parse(line);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
    index = buffer.indexOf('\n');
  }
});

child.stderr.on('data', (chunk) => process.stderr.write(chunk));

function send(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 200_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

(async () => {
  const init = await send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'dsh-delegate-smoke', version: '1' },
  });
  console.log('✓ initialize', init.serverInfo.name, init.serverInfo.version);

  const list = await send('tools/list', {});
  const names = list.tools.map((tool) => tool.name);
  console.log('✓ tools:', names.join(', '));
  for (const required of ['dsh_task', 'dsh_parallel', 'dsh_job']) {
    if (!names.includes(required)) throw new Error(`缺少工具 ${required}`);
  }

  if (live) {
    const started = Date.now();
    const result = await send('tools/call', {
      name: 'dsh_task',
      arguments: { task: '只回复两个字：可用', soft_wait_ms: 180_000 },
    });
    const text = result.content[0].text;
    console.log(`✓ live call (${Math.round((Date.now() - started) / 1000)}s):`, text.split('\n').slice(0, 2).join(' | '));
  }

  child.kill();
  console.log('\nSMOKE OK');
  process.exit(0);
})().catch((cause) => {
  console.error('SMOKE FAILED:', cause.message);
  child.kill();
  process.exit(1);
});
