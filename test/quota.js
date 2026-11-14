#!/usr/bin/env node
'use strict';

/**
 * Unit tests for lib/quota.js. Offline and self-contained: everything runs in a
 * throwaway DSH_HOME / CODEX_HOME and is removed afterwards.
 *
 *   node test/quota.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-quota-'));
const DSH = path.join(ROOT, 'dsh');
fs.mkdirSync(DSH, { recursive: true });
process.env.DSH_HOME = DSH;
process.env.CLAUDE_PROJECTS_DIR = path.join(ROOT, 'claude-projects');

const quota = require('../lib/quota');

const SETTINGS = path.join(DSH, 'delegate.json');
const CODEX = path.join(ROOT, 'codex');

let pass = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function resetQuota() {
  fs.rmSync(quota.quotaFile(), { force: true });
}

function writeQuota(value) {
  const file = quota.quotaFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

function writeSettings(value) {
  fs.writeFileSync(SETTINGS, JSON.stringify(value));
}

/** Write a rollout log; returns its final mtime. */
function writeRollout(home, year, month, day, name, lines, mtimeSeconds) {
  const dir = path.join(home, 'sessions', year, month, day);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  if (mtimeSeconds !== undefined) fs.utimesSync(file, mtimeSeconds, mtimeSeconds);
  return file;
}

const now = Date.now();
const future5 = Math.floor(now / 1000) + 3600;
const future7 = Math.floor(now / 1000) + 7 * 86400;
const past = Math.floor(now / 1000) - 60;

// ---------------------------------------------------------------- Claude

console.log('\n== recordClaude / readClaude ==');
{
  resetQuota();
  const input = {
    rate_limits: {
      five_hour: { used_percentage: 82.4, resets_at: future5 },
      seven_day: { used_percentage: 41, resets_at: future7 },
    },
  };
  const recorded = quota.recordClaude(input, now);
  check(
    '有 rate_limits 时返回 snapshot',
    recorded &&
      recorded.source === 'claude' &&
      recorded.at === now &&
      recorded.windows.five_hour.used === 82.4 &&
      recorded.windows.seven_day.used === 41,
  );
  check('快照写到 quotaFile()', fs.existsSync(quota.quotaFile()));

  const back = quota.readClaude(now);
  check(
    '能读回两个窗口',
    back &&
      back.source === 'claude' &&
      back.windows.five_hour.used === 82.4 &&
      back.windows.seven_day.used === 41,
  );

  resetQuota();
  check('没有 rate_limits 返回 null', quota.recordClaude({}, now) === null);
  check('没有 rate_limits 时不写文件', !fs.existsSync(quota.quotaFile()));

  resetQuota();
  const bad = {
    rate_limits: {
      five_hour: { used_percentage: '82', resets_at: future5 },
      seven_day: { used_percentage: null, resets_at: future7 },
    },
  };
  check('used_percentage 非数字时返回 null', quota.recordClaude(bad, now) === null);
  check('used_percentage 非数字时不写文件', !fs.existsSync(quota.quotaFile()));

  resetQuota();
  const partial = quota.recordClaude(
    {
      rate_limits: {
        five_hour: { used_percentage: 12, resets_at: future5 },
        seven_day: { used_percentage: 'nope', resets_at: future7 },
      },
    },
    now,
  );
  check('只保留有效窗口', partial && partial.windows.five_hour && !partial.windows.seven_day);
}

{
  resetQuota();
  check('文件不存在时 readClaude 返回 null', quota.readClaude(now) === null);

  writeQuota({
    source: 'claude',
    at: now,
    windows: {
      five_hour: { used: 90, resetsAt: past },
      seven_day: { used: 30, resetsAt: future7 },
    },
  });
  const filtered = quota.readClaude(now);
  check(
    '已过 resetsAt 的窗口被丢弃',
    filtered && !filtered.windows.five_hour && filtered.windows.seven_day.used === 30,
  );

  writeQuota({
    source: 'claude',
    at: now,
    windows: {
      five_hour: { used: 90, resetsAt: past },
      seven_day: { used: 30, resetsAt: past - 60 },
    },
  });
  check('窗口全部过期时返回 null', quota.readClaude(now) === null);

  writeQuota('{ this is not json');
  check('文件损坏时返回 null', quota.readClaude(now) === null);
}

// ---------------------------------------------------------------- transcript fallback

console.log('\n== readClaudeLimit（桌面 Code 标签的触顶记录）==');
{
  const projects = process.env.CLAUDE_PROJECTS_DIR;
  const projectDir = path.join(projects, 'C--Users-zzm12');
  fs.mkdirSync(projectDir, { recursive: true });
  const at = new Date(now).toISOString();
  fs.writeFileSync(
    path.join(projectDir, 'd8f99f80.jsonl'),
    [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({
        type: 'assistant',
        timestamp: at,
        apiError: 'usage_limit_reached',
        apiErrorParams: {
          rate_limit_info: { status: 'rejected', resetsAt: future5, rateLimitType: 'five_hour' },
        },
        quotaLimits: { status: 'rejected', resetsAt: future5, rateLimitType: 'five_hour' },
      }),
    ].join('\n'),
  );

  const limit = quota.readClaudeLimit(now, projects);
  check(
    '从会话日志读到已触顶',
    limit &&
      limit.resetsAt === future5 &&
      limit.type === 'five_hour' &&
      limit.window === 'five_hour',
  );

  resetQuota();
  const merged = quota.readClaude(now);
  check(
    '没有 statusline 快照时也能给出 limit',
    merged &&
      merged.source === 'claude' &&
      Object.keys(merged.windows).length === 0 &&
      merged.limit &&
      merged.limit.resetsAt === future5,
  );
  check('触顶时档位为 critical', quota.level(merged, { high: 70, critical: 90 }) === 'critical');

  const text = quota.advice(merged, 'Claude', { high: 70, critical: 90 });
  check(
    '触顶提示包含「已用尽」、重置时间与 dsh_task',
    text.includes('额度已经用尽') && text.includes('重置') && text.includes('dsh_task'),
  );

  const expiredRoot = path.join(ROOT, 'claude-projects-expired');
  fs.mkdirSync(path.join(expiredRoot, 'p'), { recursive: true });
  fs.writeFileSync(
    path.join(expiredRoot, 'p', 's.jsonl'),
    JSON.stringify({
      type: 'assistant',
      timestamp: at,
      apiError: 'usage_limit_reached',
      apiErrorParams: {
        rate_limit_info: { status: 'rejected', resetsAt: past, rateLimitType: 'five_hour' },
      },
    }),
  );
  check('重置时间已过的触顶被丢弃', quota.readClaudeLimit(now, expiredRoot) === null);
  check('没有日志目录时返回 null', quota.readClaudeLimit(now, path.join(ROOT, 'nope')) === null);

  const bomRoot = path.join(ROOT, 'claude-projects-bom');
  fs.mkdirSync(path.join(bomRoot, 'p'), { recursive: true });
  fs.writeFileSync(
    path.join(bomRoot, 'p', 's.jsonl'),
    `\uFEFF${JSON.stringify({
      type: 'assistant',
      timestamp: at,
      quotaLimits: { status: 'rejected', resetsAt: future7, rateLimitType: 'seven_day' },
    })}`,
  );
  const bom = quota.readClaudeLimit(now, bomRoot);
  check(
    '带 BOM 的行能解析，seven_day 映射到本周',
    bom && bom.resetsAt === future7 && bom.window === 'seven_day' && bom.type === 'seven_day',
  );
}

// ---------------------------------------------------------------- Codex

console.log('\n== readCodex ==');
{
  const latestFile = writeRollout(
    CODEX,
    '2026',
    '11',
    '14',
    'rollout-a.jsonl',
    [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            limit_id: 'codex',
            primary: { used_percent: 12.5, window_minutes: 300, resets_at: future5 },
            secondary: { used_percent: 40.0, window_minutes: 10080, resets_at: future7 },
            credits: null,
          },
        },
      }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'done' } }),
      JSON.stringify({ type: 'turn_context', payload: { cwd: 'C:\\work' } }),
    ],
    Math.floor(now / 1000) - 60,
  );
  writeRollout(
    CODEX,
    '2026',
    '11',
    '13',
    'rollout-b.jsonl',
    [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            primary: { used_percent: 99, window_minutes: 300, resets_at: future5 },
            secondary: null,
          },
        },
      }),
    ],
    Math.floor(now / 1000) - 120,
  );

  const latestStat = fs.statSync(latestFile);
  const snapshot = quota.readCodex(now, CODEX);
  check(
    '从最新的日期目录读出两个窗口',
    snapshot &&
      snapshot.source === 'codex' &&
      snapshot.windows.five_hour.used === 12.5 &&
      snapshot.windows.seven_day.used === 40,
  );
  check('at 用该文件的 mtime（毫秒）', snapshot && Math.abs(snapshot.at - latestStat.mtimeMs) < 5);

  const emptyCodex = path.join(ROOT, 'no-sessions');
  check('没有 sessions 目录时返回 null', quota.readCodex(now, emptyCodex) === null);

  const nullPrimaryHome = path.join(ROOT, 'codex-null-primary');
  writeRollout(
    nullPrimaryHome,
    '2026',
    '11',
    '15',
    'rollout-c.jsonl',
    [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            primary: null,
            secondary: { used_percent: 55, window_minutes: 10080, resets_at: future7 },
          },
        },
      }),
    ],
    Math.floor(now / 1000) - 30,
  );
  const nullPrimary = quota.readCodex(now, nullPrimaryHome);
  check(
    'primary 为 null 时只读 secondary',
    nullPrimary && !nullPrimary.windows.five_hour && nullPrimary.windows.seven_day.used === 55,
  );

  const expiredHome = path.join(ROOT, 'codex-expired');
  writeRollout(
    expiredHome,
    '2026',
    '11',
    '16',
    'rollout-d.jsonl',
    [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            primary: { used_percent: 60, window_minutes: 300, resets_at: past },
            secondary: null,
          },
        },
      }),
    ],
    Math.floor(now / 1000) - 10,
  );
  check('Codex 已过 resetsAt 的窗口被丢弃', quota.readCodex(now, expiredHome) === null);
}

// ---------------------------------------------------------------- levels

console.log('\n== level / thresholds ==');
{
  const t = { high: 70, critical: 90 };
  const snapshot = (used) => ({
    source: 'claude',
    at: now,
    windows: { five_hour: { used, resetsAt: future5 } },
  });
  check('null → unknown', quota.level(null, t) === 'unknown');
  check('50 → normal', quota.level(snapshot(50), t) === 'normal');
  check('70 → high（含边界）', quota.level(snapshot(70), t) === 'high');
  check('90 → critical（含边界）', quota.level(snapshot(90), t) === 'critical');

  writeSettings({ quotaHighPct: 80, quotaCriticalPct: 95 });
  const custom = quota.thresholds();
  check('settings 里的 80/95 生效', custom.high === 80 && custom.critical === 95);

  writeSettings({ quotaHighPct: 95, quotaCriticalPct: 50 });
  const fallback = quota.thresholds();
  check('high >= critical 时回退 70/90', fallback.high === 70 && fallback.critical === 90);

  fs.rmSync(SETTINGS, { force: true });
  const defaults = quota.thresholds();
  check('没有 settings 时用 70/90', defaults.high === 70 && defaults.critical === 90);
}

// ---------------------------------------------------------------- advice

console.log('\n== advice / formatReset ==');
{
  const t = { high: 70, critical: 90 };
  const snapshot = (fiveHour, sevenDay) => ({
    source: 'claude',
    at: now,
    windows: {
      five_hour: { used: fiveHour, resetsAt: future5 },
      seven_day: { used: sevenDay, resetsAt: future7 },
    },
  });

  check('normal 时返回空串', quota.advice(snapshot(50, 20), 'Claude', t) === '');

  const high = quota.advice(snapshot(82.4, 41), 'Claude', t);
  check('high 提示包含最大百分比与 dsh_task', high.includes('82%') && high.includes('dsh_task'));
  check('high 提示列出两个窗口', high.includes('5 小时 82%') && high.includes('本周 41%'));
  check('high 提示带重置时间', high.includes('重置）'));

  const critical = quota.advice(snapshot(95, 60), 'Claude', t);
  check(
    'critical 提示包含剩余百分比与 dsh_task',
    critical.includes('只剩不到 5%') && critical.includes('dsh_task'),
  );

  const custom = quota.advice(snapshot(80, 20), 'Codex', { high: 80, critical: 95 });
  check('自定义档位 80 即为 high，并带 who', custom.includes('Codex') && custom.includes('80%'));

  const sameNow = new Date(2026, 10, 14, 15, 30, 0).getTime();
  const sameReset = new Date(2026, 10, 14, 9, 5, 0).getTime() / 1000;
  check('formatReset 当天 → HH:mm', quota.formatReset(sameReset, sameNow) === '09:05');

  const laterReset = new Date(2026, 10, 18, 9, 0, 0).getTime() / 1000;
  check('formatReset 非当天 → M月D日 HH:mm', quota.formatReset(laterReset, sameNow) === '11月18日 09:00');

  const yearReset = new Date(2027, 0, 5, 8, 3, 0).getTime() / 1000;
  check('formatReset 月日不补零、时分补零', quota.formatReset(yearReset, sameNow) === '1月5日 08:03');
}

try {
  fs.rmSync(ROOT, { recursive: true, force: true });
} catch {
  /* a temporary directory left behind is harmless */
}

console.log(`\n结果: ${pass} 通过, ${failures.length} 失败`);
if (failures.length) {
  console.log('\n失败项:');
  for (const item of failures) console.log(`  - ${item}`);
}
process.exit(failures.length ? 1 : 0);
