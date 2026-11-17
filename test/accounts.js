#!/usr/bin/env node
'use strict';

/**
 * 账号列表解析与切换：只看插件配置里的 accounts[]，不碰真实 profile。
 * 在隔离的 DSH_HOME 里造一份 cordis.patch.yml 来测。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const sandbox = path.join(os.tmpdir(), `dsh-accounts-${Date.now()}`);
const profileDir = path.join(sandbox, 'profiles', 'headless');
fs.mkdirSync(profileDir, { recursive: true });

const patch = `# test patch
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: dsh-opencode-go
    model: deepseek-v4.1-flash

- id: opencode-go
  name: dsh-opencode-go
  config:
    accounts:
      - id: ap
        name: "AP"
        apiKeyEnv: ap
      - id: old
        name: "1"
        apiKeyEnv: OLD_KEY
    apiKeyEnv: ap
    autoSwitch: true
`;
fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), patch);
fs.writeFileSync(path.join(sandbox, '.env'), 'ap=secret-a\nOLD_KEY=secret-b\n');

process.env.DSH_HOME = sandbox;
const accounts = require(path.join(ROOT, 'lib', 'accounts'));

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('\n== 解析 ==');
{
  const state = accounts.read();
  check('能读到插件配置', state.ok, state.error);
  check('账号数量 2', state.accounts.length === 2, String(state.accounts.length));
  check('当前账号是 ap', state.current === 'ap', state.current);
  check('两个账号的 key 都存在', state.accounts.every((a) => a.hasKey));
  check('autoSwitch 为 true', state.autoSwitch === true);
}

console.log('\n== 切换 ==');
{
  const after = accounts.switchTo('old');
  check('切换后当前账号是 OLD_KEY', after.current === 'OLD_KEY', after.current);
  const text = fs.readFileSync(accounts.patchFile(), 'utf8');
  const rowLevel = (text.match(/^\s{4}apiKeyEnv:\s*(\S+)\s*$/gm) || []).map((l) => l.trim());
  check('只改 row 级的 apiKeyEnv', rowLevel.length === 1 && rowLevel[0] === 'apiKeyEnv: OLD_KEY', rowLevel.join('|'));
  check('账号条目里的 apiKeyEnv 未被改', /- id: ap[\s\S]*?apiKeyEnv: ap/.test(text));

  const back = accounts.switchTo('ap');
  check('再切回 ap', back.current === 'ap', back.current);
}

console.log('\n== 自动切换开关 ==');
{
  const off = accounts.setAutoSwitch(false);
  check('关闭后为 false', off.autoSwitch === false);
  const on = accounts.setAutoSwitch(true);
  check('打开后为 true', on.autoSwitch === true);
}

console.log('\n== 异常输入 ==');
{
  let threw = false;
  try {
    accounts.switchTo('nope');
  } catch {
    threw = true;
  }
  check('未知账号报错', threw);

  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '- id: other\n  name: something-else\n');
  const missing = accounts.read();
  check('没有插件配置时返回 ok=false', missing.ok === false);
}

fs.rmSync(sandbox, { recursive: true, force: true });

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (failures.length) {
  console.log('\n失败项:');
  for (const item of failures) console.log('  - ' + item);
}
process.exit(fail ? 1 : 0);
