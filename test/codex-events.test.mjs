import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { buildSync } from 'esbuild';

const require = createRequire(import.meta.url);
const built = buildSync({
  entryPoints: [resolve('src/core/codex.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
});
const loaded = { exports: {} };
new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports);
const { CodexClient } = loaded.exports;

function runningTurn() {
  const progress = [];
  let resolve;
  const completed = new Promise((done) => { resolve = done; });
  const turn = {
    threadId: 'thread-1',
    turnId: 'turn-1',
    messages: new Map(),
    summaries: new Map(),
    progress: new Map(),
    pendingNotifications: [],
    events: {
      onProgress: (value) => progress.push(value),
      onQuestion() {},
      onApproval() {},
    },
    resolve,
    completed,
  };
  return { turn, progress, completed };
}

function notify(client, method, params) {
  client.receive(JSON.stringify({ method, params }));
}

test('Codex 0.158 reasoning summaries accumulate by item and summary index', async () => {
  const client = new CodexClient({ binaryPath: 'unused', log: () => {} });
  const { turn, progress, completed } = runningTurn();
  client.turns.set(turn.threadId, turn);

  notify(client, 'item/reasoning/summaryPartAdded', {
    threadId: 'thread-1', turnId: 'turn-1', itemId: 'reasoning-1', summaryIndex: 0,
    summaryPart: { type: 'summaryText' },
  });
  notify(client, 'item/reasoning/summaryTextDelta', {
    threadId: 'thread-1', turnId: 'turn-1', itemId: 'reasoning-1', summaryIndex: 0,
    delta: '开始执行。',
  });
  notify(client, 'item/reasoning/summaryPartAdded', {
    threadId: 'thread-1', turnId: 'turn-1', itemId: 'reasoning-1', summaryIndex: 1,
    summaryPart: { type: 'summaryText' },
  });
  notify(client, 'item/completed', {
    threadId: 'thread-1', turnId: 'turn-1',
    item: {
      type: 'reasoning', id: 'reasoning-1',
      summary: ['检查输入。开始执行。', '生成结果。'],
    },
  });

  const summaries = progress.filter((item) => item.kind === 'summary');
  assert.ok(summaries.some((item) => item.key === 'reasoning:reasoning-1:0' && item.text.includes('检查输入。')));
  assert.ok(summaries.some((item) => item.key === 'reasoning:reasoning-1:0' && item.text.includes('开始执行。')));
  assert.ok(summaries.some((item) => item.key === 'reasoning:reasoning-1:1' && item.text.includes('生成结果。')));

  notify(client, 'turn/completed', {
    threadId: 'thread-1', turnId: 'turn-1', turn: { id: 'turn-1', status: 'completed' },
  });
  assert.equal((await completed).status, 'completed');
});

test('plan and operation notifications emit current keyed state and ignore other or late turns', async () => {
  const client = new CodexClient({ binaryPath: 'unused', log: () => {} });
  const { turn, progress, completed } = runningTurn();
  client.turns.set(turn.threadId, turn);

  notify(client, 'turn/plan/updated', {
    threadId: 'thread-1', turnId: 'turn-1',
    plan: [
      { step: '检查文件', status: 'completed' },
      { step: '更新文件', status: 'inProgress' },
    ],
  });
  notify(client, 'item/started', {
    threadId: 'thread-1', turnId: 'turn-1',
    item: { id: 'operation-1', type: 'commandExecution', command: 'inspect files' },
  });
  notify(client, 'item/completed', {
    threadId: 'thread-1', turnId: 'turn-1',
    item: { id: 'operation-1', type: 'commandExecution', command: 'inspect files', status: 'completed' },
  });

  const plan = progress.filter((item) => item.kind === 'plan');
  assert.ok(plan.some((item) => item.key === 'plan:0' && item.status === 'completed' && item.text.includes('检查文件')));
  assert.ok(plan.some((item) => item.key === 'plan:1' && item.status === 'inProgress' && item.text.includes('更新文件')));
  const operation = progress.filter((item) => item.kind === 'operation' && item.key === 'operation:operation-1');
  assert.ok(operation.some((item) => item.status === 'inProgress'));
  assert.ok(operation.some((item) => item.status === 'completed'));

  const countBeforeForeignEvents = progress.length;
  notify(client, 'item/reasoning/summaryTextDelta', {
    threadId: 'other-thread', turnId: 'turn-1', itemId: 'late', summaryIndex: 0, delta: 'wrong thread',
  });
  notify(client, 'turn/plan/updated', {
    threadId: 'thread-1', turnId: 'old-turn', plan: [{ step: 'stale', status: 'inProgress' }],
  });
  assert.equal(progress.length, countBeforeForeignEvents);

  notify(client, 'turn/completed', {
    threadId: 'thread-1', turnId: 'turn-1', turn: { id: 'turn-1', status: 'completed' },
  });
  await completed;
  const countAfterTerminal = progress.length;
  notify(client, 'item/started', {
    threadId: 'thread-1', turnId: 'turn-1', item: { id: 'too-late', type: 'commandExecution' },
  });
  assert.equal(progress.length, countAfterTerminal);
});
