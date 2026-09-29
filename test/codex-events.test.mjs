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

test('agentMessage commentary and final_answer phases survive start and delta events', () => {
  const client = new CodexClient({ binaryPath: 'unused', log: () => {} });
  const { turn, progress } = runningTurn();
  client.turns.set(turn.threadId, turn);

  notify(client, 'item/started', {
    threadId: 'thread-1', turnId: 'turn-1',
    item: { id: 'commentary-1', type: 'agentMessage', phase: 'commentary' },
  });
  notify(client, 'item/agentMessage/delta', {
    threadId: 'thread-1', turnId: 'turn-1', itemId: 'commentary-1', delta: '正在检查设置。',
  });
  notify(client, 'item/started', {
    threadId: 'thread-1', turnId: 'turn-1',
    item: { id: 'final-1', type: 'agentMessage', phase: 'final_answer' },
  });
  notify(client, 'item/agentMessage/delta', {
    threadId: 'thread-1', turnId: 'turn-1', itemId: 'final-1', delta: '检查完成。',
  });

  assert.deepEqual(progress.filter((item) => item.kind === 'message').map(({ phase, text }) => ({ phase, text })), [
    { phase: 'commentary', text: '正在检查设置。' },
    { phase: 'final_answer', text: '检查完成。' },
  ]);
});

test('file and image operations use Simplified Chinese labels and omit command exit codes', () => {
  const logs = [];
  const client = new CodexClient({ binaryPath: 'unused', log: (...entry) => logs.push(entry) });
  const { turn, progress } = runningTurn();
  client.turns.set(turn.threadId, turn);
  const item = (id, type, extra = {}) => ({ id, type, ...extra });
  const notifyItem = (method, value) => notify(client, method, {
    threadId: 'thread-1', turnId: 'turn-1', item: value,
  });

  notifyItem('item/started', item('read-1', 'commandExecution', { commandActions: [{ type: 'read' }] }));
  notifyItem('item/completed', item('read-1', 'commandExecution', {
    commandActions: [{ type: 'read' }], status: 'completed',
  }));
  notifyItem('item/started', item('list-1', 'commandExecution', { commandActions: [{ type: 'listFiles' }] }));
  notifyItem('item/completed', item('list-1', 'commandExecution', {
    commandActions: [{ type: 'listFiles' }], status: 'completed',
  }));
  notifyItem('item/started', item('search-1', 'commandExecution', { commandActions: [{ type: 'search' }] }));
  notifyItem('item/completed', item('search-1', 'commandExecution', {
    commandActions: [{ type: 'search' }], status: 'failed', exitCode: 1,
  }));
  notifyItem('item/started', item('search-error-1', 'commandExecution', { commandActions: [{ type: 'search' }] }));
  notifyItem('item/completed', item('search-error-1', 'commandExecution', {
    commandActions: [{ type: 'search' }], status: 'failed', exitCode: 2,
  }));
  notifyItem('item/started', item('unknown-1', 'commandExecution', { commandActions: [{ type: 'unknown' }] }));
  notifyItem('item/completed', item('unknown-1', 'commandExecution', {
    commandActions: [{ type: 'unknown' }], status: 'failed', exitCode: 127,
  }));
  notifyItem('item/started', item('image-1', 'imageView', { path: '/tmp/mock.png' }));
  notifyItem('item/completed', item('image-1', 'imageView', { path: '/tmp/mock.png' }));

  const operations = progress.filter((entry) => entry.kind === 'operation');
  assert.ok(operations.some((entry) => entry.text === '正在读取文件'));
  assert.ok(operations.some((entry) => entry.text === '已读取文件'));
  assert.ok(operations.some((entry) => entry.text === '正在查看文件列表'));
  assert.ok(operations.some((entry) => entry.text === '已查看文件列表'));
  assert.ok(operations.some((entry) => entry.text === '正在搜索文件'));
  assert.ok(operations.some((entry) => entry.text === '正在查看图像'));
  assert.ok(operations.some((entry) => entry.text === '已查看图像'));
  const failedSearch = operations.filter((entry) => entry.key === 'operation:search-1').at(-1);
  assert.ok(failedSearch);
  assert.equal(failedSearch.text, '搜索未找到结果');
  assert.doesNotMatch(JSON.stringify(failedSearch), /命令执行失败|退出码|exitCode/);
  const searchError = operations.filter((entry) => entry.key === 'operation:search-error-1').at(-1);
  assert.equal(searchError?.text, '搜索文件遇到问题');
  assert.doesNotMatch(JSON.stringify(searchError), /命令执行失败|退出码|exitCode/);
  const unknownAction = operations.filter((entry) => entry.key === 'operation:unknown-1').at(-1);
  assert.equal(unknownAction?.text, '命令运行遇到问题');
  assert.doesNotMatch(JSON.stringify(unknownAction), /命令执行失败|退出码|exitCode/);
  assert.ok(logs.some(([level, message]) => level === 'WARN' && message.includes('exitCode=2')));
});
