'use strict';

/**
 * 继续失败的任务。
 *
 * 失败的运行记录里带着 sessionId，DSH 支持用 --session-id 续接同一个会话，所以
 * 「继续」不是重跑，而是让子代理接着上次的上下文往下做。只对可重试的失败
 * （网关超时、连接被重置、过载）自动继续；写作用域错误、任务写错这类不会重试。
 */

const dsh = require('./dsh');
const runlog = require('./runlog');
const { readSettings } = require('./config');

const RETRYABLE = /TIMEOUT|timed out|ECONNRESET|ETIMEDOUT|socket hang up|overloaded|ECONNREFUSED|502|503|529|rate.?limit/i;

/** 正在续接的源记录 / 正在使用的会话；同一目标绝不并发。 */
const inFlight = new Set();
const busySessions = new Set();

const CONTINUE_PROMPT = [
  '继续上一次没做完的任务。',
  '先确认当前目录和文件的实际状态（已经改到哪一步），然后只补还没做的部分，不要从头重来。',
  '做完用一段话汇报：完成了什么、还剩什么、有没有需要我拿主意的地方。',
].join('\n');

/** 这条记录值得继续吗（成功的、没有 session 的、不可重试的都不算）。 */
function retryable(meta) {
  if (!meta || (meta.state !== 'failed' && meta.state !== 'lost')) return false;
  if (!meta.sessionId) return false;
  return RETRYABLE.test(String(meta.reason || ''));
}

/** 已经被继续过的源记录 id，避免自动继续反复触发。 */
function alreadyResumed() {
  const seen = new Set();
  for (const run of runlog.listRuns(500)) {
    if (run.sourceRunId) seen.add(run.sourceRunId);
  }
  return seen;
}

/**
 * 挑出要继续的记录：默认全部可重试的失败，倒序，去重。
 * @returns {{candidates: object[], skipped: {id: string, why: string}[]}}
 */
function skipSet() {
  try {
    const { readSettings } = require('./config');
    const list = readSettings().skipSessions;
    return new Set(Array.isArray(list) ? list : []);
  } catch {
    return new Set();
  }
}

function pickCandidates(options = {}) {
  const limit = Number.isFinite(options.limit) ? options.limit : 8;
  const force = options.force === true;
  const runs = runlog.listRuns(500);
  const resumed = alreadyResumed();
  const skip = skipSet();
  const byId = new Map(runs.map((run) => [run.id, run]));

  const wanted = options.ids && options.ids.length ? options.ids.map((id) => byId.get(id)).filter(Boolean) : runs;

  const candidates = [];
  const skipped = [];
  for (const run of wanted) {
    if (run.sourceRunId) {
      skipped.push({ id: run.id, why: '这是一次续接，跳过' });
      continue;
    }
    if (!retryable(run)) {
      skipped.push({ id: run.id, why: run.state !== 'failed' ? `状态是 ${run.state}` : run.sessionId ? '错误不可重试' : '没有 session id' });
      continue;
    }
    if (skip.has(run.sessionId)) {
      skipped.push({ id: run.id, why: '在 skipSessions 里（已完成，别再动它）' });
      continue;
    }
    if (!force && resumed.has(run.id)) {
      skipped.push({ id: run.id, why: '已经继续过' });
      continue;
    }
    if (inFlight.has(run.id) || busySessions.has(run.sessionId)) {
      skipped.push({ id: run.id, why: '正在继续中' });
      continue;
    }
    candidates.push(run);
    if (options.ids ? false : candidates.length >= limit) break;
  }
  return { candidates, skipped };
}

/** 继续一条记录，返回新记录的结果。 */
async function resumeOne(meta, options = {}) {
  inFlight.add(meta.id);
  busySessions.add(meta.sessionId);
  const record = runlog.createRun({
    kind: 'resume',
    title: `继续：${String(meta.title || meta.id).slice(0, 48)}`,
    cwd: meta.cwd,
    sourceRunId: meta.id,
  });
  runlog.append(record, { kind: 'text', text: `续接会话 ${meta.sessionId}` });

  const result = await dsh.runTask({
    task: options.task || CONTINUE_PROMPT,
    cwd: meta.cwd,
    sessionId: meta.sessionId,
    permissionMode: meta.permissionMode,
    approvalPolicy: meta.approvalPolicy,
    timeoutMs: options.timeoutMs || 0,
    // Mirror the worker's events into the run record, so a resumed task shows the
    // same live tool/text stream the MCP path does instead of sitting at 0 tools.
    onEvent: (event) => {
      if (!event || !event.type) return;
      if (event.type === 'tool_call') {
        const input = event.input || {};
        runlog.append(record, {
          kind: 'tool',
          name: event.tool,
          detail: input.command || input.path || input.query || '',
        });
      } else if (event.type === 'text' && event.text) {
        runlog.append(record, { kind: 'text', text: event.text });
      } else if (event.type === 'thinking' && event.text) {
        runlog.append(record, { kind: 'thinking', text: event.text });
      }
    },
  });

  runlog.finish(record, result);
  inFlight.delete(meta.id);
  busySessions.delete(meta.sessionId);
  return { source: meta.id, run: record.id, ok: Boolean(result.ok), reason: result.reason || null };
}

/**
 * 并发继续多条（默认 2，避免又把网关压垮）。
 * @returns {Promise<{results: object[], failed: number}>}
 */
async function resumeMany(metas, options = {}) {
  const concurrency = Math.max(1, Math.min(Number(options.concurrency) || 2, 8));
  // 错峰：并发 8 时 8 个首请求同时打到同一网关，正是上次整批 TIMEOUT 的形态。
  const staggerMs = Number.isFinite(options.staggerMs) ? options.staggerMs : 1200;
  // Reserve the whole batch up front: a source that is merely queued must already
  // look busy, or the 30s auto-resume tick picks it again and the two children
  // fight over the same session ("already owned by an active write handle").
  for (const meta of metas) {
    inFlight.add(meta.id);
    if (meta.sessionId) busySessions.add(meta.sessionId);
  }
  const queue = metas.slice();
  const results = [];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async (_, index) => {
    // Stagger the first wave: eight agents hitting the same gateway in the same
    // second is what produced the all-TIMEOUT batch, not eight agents per se.
    if (index > 0 && staggerMs > 0) await new Promise((resolve) => setTimeout(resolve, index * staggerMs));
    while (queue.length) {
      const meta = queue.shift();
      try {
        results.push(await resumeOne(meta, options));
      } catch (cause) {
        results.push({ source: meta.id, ok: false, reason: cause.message });
      }
    }
  });
  await Promise.all(workers);
  for (const meta of metas) {
    inFlight.delete(meta.id);
    if (meta.sessionId) busySessions.delete(meta.sessionId);
  }
  return { results, failed: results.filter((item) => !item.ok).length };
}

/** 自动继续：给守护进程的定时器调用。 */
async function autoResumeTick(options = {}) {
  const settings = readSettings();
  if (settings.autoResume === false) return { resumed: 0, reason: 'autoResume 已关闭' };
  const limit = Number.isFinite(settings.autoResumeLimit) ? settings.autoResumeLimit : 2;
  const { candidates } = pickCandidates({ limit });
  if (!candidates.length) return { resumed: 0 };
  const { results } = await resumeMany(candidates, { concurrency: options.concurrency || 2 });
  return { resumed: results.length, results };
}

module.exports = { CONTINUE_PROMPT, retryable, pickCandidates, resumeOne, resumeMany, autoResumeTick };
