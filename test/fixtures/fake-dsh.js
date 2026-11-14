#!/usr/bin/env node
'use strict';

/**
 * Stand-in for `dsh --profile headless --json … -`: reads the task from stdin and
 * prints DSH-style JSON events. "SLEEP=<ms>" anywhere in the task delays the final
 * event, so tests can hold a job open. Never calls a model.
 */

const args = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  const sleep = Number((input.match(/SLEEP=(\d+)/) || [])[1] || 0);
  const sessionId = `session-fake-${process.pid}`;
  const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
  emit({ type: 'session', sessionId });
  emit({ type: 'status', phase: 'turn_start', turn: 1 });
  emit({ type: 'tool_call', name: 'bash', input: { command: 'echo fake' } });
  setTimeout(() => {
    // "ECHO_TASK" anywhere in the task: return the full text the worker received.
    const echo = input.includes('ECHO_TASK') ? `\n${input}` : '';
    emit({
      type: 'final',
      text: `fake-dsh ok ${JSON.stringify({ cwd: process.cwd(), args, bytes: input.length })}${echo}`,
      reason: { kind: 'completed' },
      sessionId,
    });
    process.exit(0);
  }, sleep);
});
