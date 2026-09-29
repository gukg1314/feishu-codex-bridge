import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { buildSync } from 'esbuild';

const require = createRequire(import.meta.url);
const built = buildSync({
  entryPoints: [resolve('src/core/bridge.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
});
const loaded = { exports: {} };
new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports);
const { Bridge } = loaded.exports;

const settings = {
  appId: 'cli_test',
  allowedOpenIds: ['ou_owner'],
  allowedChatIds: ['oc_allowed'],
  workingDirectory: '/tmp',
  model: 'gpt-6-sol',
  effort: 'max',
  sessionTimeoutHours: 24,
  allowGroupMentions: true,
  launchAtLogin: false,
  autoConnect: false,
};

function message(messageId, overrides = {}) {
  return {
    messageId, chatId: 'oc_allowed', chatType: 'group', senderOpenId: 'ou_owner',
    text: '请处理', mentionsBot: true, attachments: [], ...overrides,
  };
}

async function waitFor(check, timeoutMs = 1_000) {
  for (let attempt = 0; attempt < Math.ceil(timeoutMs / 5); attempt++) {
    if (check()) return;
    await delay(5);
  }
  assert.fail('等待假桥接事件超时');
}

class FakeLark {
  cards = [];
  images = [];
  files = [];
  reactions = [];
  removedReactions = [];

  async start(handlers) { this.handlers = handlers; }
  async stop() { this.handlers = undefined; }
  async sendCard(chatId, snapshot) {
    const id = `om_card_${this.cards.length + 1}`;
    this.cards.push({ id, chatId, snapshot });
    return id;
  }
  async updateCard(id, snapshot) { this.cards.find((card) => card.id === id).snapshot = snapshot; }
  async sendText() {}
  async sendImage(chatId, path) { this.images.push({ chatId, path }); }
  async sendFile(chatId, path) { this.files.push({ chatId, path }); }
  async addReaction(messageId, emojiType) {
    const reactionId = `reaction_${this.reactions.length + 1}`;
    this.reactions.push({ messageId, emojiType, reactionId });
    return reactionId;
  }
  async removeReaction(messageId, reactionId) { this.removedReactions.push({ messageId, reactionId }); }
  async emitMessage(value) { await this.handlers.onMessage(value); }
  async emitAction(value) { await this.handlers.onAction(value); }
}

class FakeCodex {
  turns = [];
  startedThreads = [];
  resumedThreads = [];
  interrupted = [];
  questions = [];
  approvals = [];

  async start() {}
  async stop() {}
  async startThread(cwd, model, effort) {
    const threadId = `thread_${this.startedThreads.length + 1}`;
    this.startedThreads.push({ threadId, cwd, model, effort });
    return threadId;
  }
  async resumeThread(threadId, cwd, model, effort) {
    this.resumedThreads.push({ threadId, cwd, model, effort });
  }
  async startTurn(threadId, text, attachments, cwd, events, model, effort) {
    let complete;
    const completed = new Promise((resolveTurn) => { complete = resolveTurn; });
    const turnId = `turn_${this.turns.length + 1}`;
    this.turns.push({ threadId, turnId, text, attachments, cwd, events, model, effort, complete });
    return { turnId, completed };
  }
  async interrupt(threadId, turnId) { this.interrupted.push({ threadId, turnId }); }
  answerQuestion(id, answer) { this.questions.push({ id, answer }); }
  answerApproval(id, approved) { this.approvals.push({ id, approved }); }
}

async function harness(t, { routeData, settingsOverrides = {} } = {}) {
  const storageDir = await mkdtemp(join(tmpdir(), 'feishu-codex-bridge-test-'));
  if (routeData) await writeFile(join(storageDir, 'bridge-routes.json'), JSON.stringify(routeData));
  const lark = new FakeLark();
  const codex = new FakeCodex();
  const bridge = new Bridge({ settings: { ...settings, ...settingsOverrides }, lark, codex, storageDir, log: () => {} });
  t.after(async () => {
    for (const turn of codex.turns) turn.complete({ status: 'interrupted', text: '' });
    await bridge.stop();
    await rm(storageDir, { recursive: true, force: true });
  });
  await bridge.start();
  return { bridge, lark, codex, storageDir };
}

test('模型参数贯穿新建线程、恢复线程与 turn', async (t) => {
  const { lark, codex } = await harness(t);
  await lark.emitMessage(message('om_model_first'));
  await waitFor(() => codex.turns.length === 1);
  assert.deepEqual(codex.startedThreads[0], {
    threadId: 'thread_1', cwd: '/tmp', model: 'gpt-6-sol', effort: 'max',
  });
  assert.equal(codex.turns[0].model, 'gpt-6-sol');
  assert.equal(codex.turns[0].effort, 'max');
  assert.match(codex.turns[0].text, /简体中文/);
  for (const exception of ['代码', '路径', '命令', '专有名词']) {
    assert.ok(codex.turns[0].text.includes(exception), `语言要求应保留例外：${exception}`);
  }
  codex.turns[0].complete({ status: 'completed', text: '完成' });
  await waitFor(() => lark.cards[0].snapshot.status === 'completed');

  await lark.emitMessage(message('om_model_second'));
  await waitFor(() => codex.turns.length === 2);
  assert.deepEqual(codex.resumedThreads[0], {
    threadId: 'thread_1', cwd: '/tmp', model: 'gpt-6-sol', effort: 'max',
  });
  assert.equal(codex.startedThreads.length, 1);
  codex.turns[1].complete({ status: 'completed', text: '完成' });
  await waitFor(() => lark.cards[1].snapshot.status === 'completed');
});

test('超时的已保存会话会新建线程', async (t) => {
  const routeKey = JSON.stringify(['oc_allowed', 'ou_owner']);
  const lastActiveAt = Date.now() - 25 * 60 * 60 * 1000;
  const { lark, codex } = await harness(t, {
    routeData: { routes: { [routeKey]: { threadId: 'stale_thread', lastActiveAt } }, seen: [] },
  });
  await lark.emitMessage(message('om_timeout'));
  await waitFor(() => codex.turns.length === 1);
  assert.equal(codex.resumedThreads.length, 0);
  assert.equal(codex.startedThreads.length, 1);
  assert.equal(codex.turns[0].threadId, 'thread_1');
  codex.turns[0].complete({ status: 'completed', text: '完成' });
  await waitFor(() => lark.cards[0].snapshot.status === 'completed');
});

test('成员和群白名单、@ 条件、消息去重及 GLANCE 清理', async (t) => {
  const { lark, codex } = await harness(t);
  await lark.emitMessage(message('om_other_user', { senderOpenId: 'ou_other' }));
  await lark.emitMessage(message('om_other_chat', { chatId: 'oc_other' }));
  await lark.emitMessage(message('om_no_mention', { mentionsBot: false }));
  assert.equal(lark.cards.length, 0);
  assert.equal(lark.reactions.length, 0);
  await lark.emitMessage(message('om_valid'));
  await waitFor(() => codex.turns.length === 1);
  assert.deepEqual(lark.reactions, [{ messageId: 'om_valid', emojiType: 'GLANCE', reactionId: 'reaction_1' }]);
  await lark.emitMessage(message('om_valid'));
  assert.equal(lark.cards.length, 1);
  codex.turns[0].complete({ status: 'completed', text: '完成' });
  await waitFor(() => lark.cards[0].snapshot.status === 'completed');
  await waitFor(() => lark.removedReactions.length === 1);
  assert.deepEqual(lark.removedReactions, [{ messageId: 'om_valid', reactionId: 'reaction_1' }]);
  await lark.emitMessage(message('om_valid'));
  assert.equal(lark.cards.length, 1);
  await lark.emitMessage(message('om_failed'));
  await waitFor(() => codex.turns.length === 2);
  codex.turns[1].complete({ status: 'failed', text: '', error: '模拟失败' });
  await waitFor(() => lark.cards[1].snapshot.status === 'failed');
  await waitFor(() => lark.removedReactions.length === 2);
  assert.deepEqual(lark.removedReactions[1], { messageId: 'om_failed', reactionId: 'reaction_2' });
});

test('消息到完成卡片：图片和 Excel 双向传递，链接保留', async (t) => {
  const { lark, codex, storageDir } = await harness(t);
  const image = join(storageDir, 'picture.png');
  const excel = join(storageDir, 'data.xlsx');
  await Promise.all([writeFile(image, 'image'), writeFile(excel, 'excel')]);
  await lark.emitMessage(message('om_media', {
    text: '处理 [来源](https://example.com/report)',
    attachments: [{ kind: 'image', path: image, name: 'picture.png' }, { kind: 'file', path: excel, name: 'data.xlsx' }],
  }));
  await waitFor(() => codex.turns.length === 1);
  assert.deepEqual(codex.turns[0].attachments.map((item) => item.path), [image, excel]);
  assert.match(codex.turns[0].text, /https:\/\/example\.com\/report/);
  assert.equal(lark.cards[0].snapshot.status, 'running');
  codex.turns[0].complete({
    status: 'completed',
    text: `已处理 [来源](https://example.com/report) ![图片](${image}) [Excel](${excel})`,
  });
  await waitFor(() => lark.images.length === 1 && lark.files.length === 1);
  assert.equal(lark.cards[0].snapshot.status, 'completed');
  assert.match(lark.cards[0].snapshot.summary, /https:\/\/example\.com\/report/);
  assert.deepEqual(lark.images, [{ chatId: 'oc_allowed', path: image }]);
  assert.deepEqual(lark.files, [{ chatId: 'oc_allowed', path: excel }]);
});

test('提问回复、审批和停止卡片回调', async (t) => {
  const { bridge, lark, codex } = await harness(t);

  await lark.emitMessage(message('om_question'));
  await waitFor(() => codex.turns.length === 1);
  codex.turns[0].events.onQuestion({ id: 11, text: '继续吗？' });
  await waitFor(() => lark.cards[0].snapshot.status === 'question');
  await lark.emitMessage(message('om_reply', { text: '继续', replyToMessageId: lark.cards[0].id }));
  assert.deepEqual(codex.questions, [{ id: 11, answer: '继续' }]);
  codex.turns[0].complete({ status: 'completed', text: '完成' });
  await waitFor(() => lark.cards[0].snapshot.status === 'completed');

  await lark.emitMessage(message('om_approval'));
  await waitFor(() => codex.turns.length === 2);
  codex.turns[1].events.onApproval({ id: 12, title: '允许操作？' });
  await waitFor(() => lark.cards[1].snapshot.status === 'approval');
  const approvalCard = lark.cards[1];
  await lark.emitAction({ cardMessageId: approvalCard.id, actorOpenId: 'ou_other', action: 'approve', version: approvalCard.snapshot.version });
  assert.equal(codex.approvals.length, 0);
  await lark.emitAction({ cardMessageId: approvalCard.id, actorOpenId: 'ou_owner', action: 'approve', version: approvalCard.snapshot.version });
  assert.deepEqual(codex.approvals, [{ id: 12, approved: true }]);
  codex.turns[1].complete({ status: 'completed', text: '已批准' });
  await waitFor(() => approvalCard.snapshot.status === 'completed');

  await lark.emitMessage(message('om_stop'));
  await waitFor(() => codex.turns.length === 3);
  const stopCard = lark.cards[2];
  await lark.emitAction({ cardMessageId: stopCard.id, actorOpenId: 'ou_owner', action: 'stop', version: stopCard.snapshot.version });
  assert.deepEqual(codex.interrupted, [{ threadId: 'thread_1', turnId: 'turn_3' }]);
  assert.equal(stopCard.snapshot.status, 'stopped');
  await waitFor(() => lark.removedReactions.length === 3);
  assert.deepEqual(lark.removedReactions[2], { messageId: 'om_stop', reactionId: 'reaction_3' });
  codex.turns[2].complete({ status: 'interrupted', text: '' });
  await waitFor(() => bridge.getStatus().activeTurns === 0);
});

test('进度突发会刷新尾部，终态会取消延迟中的旧进度', async (t) => {
  const { lark, codex } = await harness(t);
  await lark.emitMessage(message('om_progress_burst'));
  await waitFor(() => codex.turns.length === 1);
  const turn = codex.turns[0];
  const card = lark.cards[0];

  turn.events.onProgress({ kind: 'summary', key: 'reasoning:item:0', text: '初始摘要' });
  await waitFor(() => card.snapshot.summary === '初始摘要');
  turn.events.onProgress({ kind: 'plan', key: 'plan:0', text: '准备环境', status: 'completed' });
  turn.events.onProgress({ kind: 'plan', key: 'plan:1', text: '读取配置', status: 'completed' });
  turn.events.onProgress({ kind: 'plan', key: 'plan:2', text: '核对字段', status: 'completed' });
  turn.events.onProgress({ kind: 'plan', key: 'plan:3', text: '写入配置', status: 'completed' });
  turn.events.onProgress({ kind: 'plan', key: 'plan:4', text: '确认结果', status: 'inProgress' });
  turn.events.onProgress({ kind: 'summary', key: 'reasoning:item:0', text: '最新公开摘要' });

  await waitFor(() => card.snapshot.summary === '最新公开摘要' && card.snapshot.currentStep === '确认结果', 2_800);
  assert.deepEqual(card.snapshot.steps.map((step) => step.title), [
    '准备环境', '读取配置', '核对字段', '写入配置', '确认结果',
  ]);

  turn.events.onProgress({ kind: 'summary', key: 'reasoning:item:0', text: '终态之后的旧进度' });
  turn.complete({ status: 'completed', text: '最终结果' });
  await waitFor(() => card.snapshot.status === 'completed');
  const terminalVersion = card.snapshot.version;
  await delay(2_700);
  assert.equal(card.snapshot.status, 'completed');
  assert.equal(card.snapshot.summary, '最终结果');
  assert.equal(card.snapshot.version, terminalVersion);
});

test('英文叙述不进入进度卡，中文进度路径与操作详情原样保留', async (t) => {
  const { bridge, lark, codex } = await harness(t);
  await lark.emitMessage(message('om_english_progress'));
  await waitFor(() => codex.turns.length === 1);
  const turn = codex.turns[0];
  const card = lark.cards[0];

  turn.events.onProgress({
    kind: 'operation', key: 'operation:read-config', text: '正在读取文件',
    detail: 'settings.json', status: 'inProgress',
  });
  turn.events.onProgress({
    kind: 'summary', key: 'reasoning:summary', text: "Now let's examine each tile: 鸡 (traditional)",
  });
  turn.events.onProgress({
    kind: 'message', phase: 'commentary', key: 'message:english-commentary',
    text: 'I found the settings file and am reviewing it.',
  });
  turn.events.onProgress({
    kind: 'message', phase: 'commentary', key: 'message:commentary',
    text: '我正在读取 /Users/example/README.md。',
  });

  await waitFor(() => card.snapshot.version > 1, 2_800);
  assert.equal(card.snapshot.summary, '我正在读取 /Users/example/README.md。');
  assert.equal(card.snapshot.steps.some((step) => step.title.includes('I found the settings file')), false);
  assert.equal(card.snapshot.steps.some((step) => step.title.includes('Now let\'s examine each tile')), false);
  assert.equal(card.snapshot.steps.find((step) => step.title === '正在读取文件')?.detail, 'settings.json');
  assert.ok(card.snapshot.steps.some((step) => step.title === '我正在读取 /Users/example/README.md。'));

  turn.complete({ status: 'interrupted', text: '' });
  await waitFor(() => bridge.getStatus().activeTurns === 0);
});

test('旧版本停止仍有效，旧版本提问与审批按钮会被拒绝', async (t) => {
  const { bridge, lark, codex } = await harness(t);

  await lark.emitMessage(message('om_old_stop'));
  await waitFor(() => codex.turns.length === 1);
  const stopCard = lark.cards[0];
  codex.turns[0].events.onProgress({ kind: 'plan', key: 'plan:0', text: '检查输入', status: 'inProgress' });
  await waitFor(() => stopCard.snapshot.version > 1);
  await lark.emitAction({ cardMessageId: stopCard.id, actorOpenId: 'ou_other', action: 'stop', version: 1 });
  assert.equal(codex.interrupted.length, 0);
  await lark.emitAction({ cardMessageId: stopCard.id, actorOpenId: 'ou_owner', action: 'stop', version: 1 });
  await waitFor(() => stopCard.snapshot.status === 'stopped');
  assert.deepEqual(codex.interrupted, [{ threadId: 'thread_1', turnId: 'turn_1' }]);
  codex.turns[0].complete({ status: 'interrupted', text: '' });
  await waitFor(() => bridge.getStatus().activeTurns === 0);

  await lark.emitMessage(message('om_old_question'));
  await waitFor(() => codex.turns.length === 2);
  codex.turns[1].events.onQuestion({ id: 21, text: '继续吗？', options: ['继续'] });
  await waitFor(() => lark.cards[1].snapshot.status === 'question');
  const questionCard = lark.cards[1];
  await lark.emitAction({
    cardMessageId: questionCard.id, actorOpenId: 'ou_owner', action: 'answer', value: '继续',
    version: questionCard.snapshot.version - 1,
  });
  assert.equal(codex.questions.length, 0);
  await lark.emitAction({
    cardMessageId: questionCard.id, actorOpenId: 'ou_owner', action: 'answer', value: '继续',
    version: questionCard.snapshot.version,
  });
  assert.deepEqual(codex.questions, [{ id: 21, answer: '继续' }]);
  codex.turns[1].complete({ status: 'completed', text: '已继续' });
  await waitFor(() => questionCard.snapshot.status === 'completed');

  await lark.emitMessage(message('om_old_approval'));
  await waitFor(() => codex.turns.length === 3);
  codex.turns[2].events.onApproval({ id: 22, title: '允许操作？' });
  await waitFor(() => lark.cards[2].snapshot.status === 'approval');
  const approvalCard = lark.cards[2];
  await lark.emitAction({
    cardMessageId: approvalCard.id, actorOpenId: 'ou_owner', action: 'approve',
    version: approvalCard.snapshot.version - 1,
  });
  assert.equal(codex.approvals.length, 0);
  await lark.emitAction({
    cardMessageId: approvalCard.id, actorOpenId: 'ou_owner', action: 'approve',
    version: approvalCard.snapshot.version,
  });
  assert.deepEqual(codex.approvals, [{ id: 22, approved: true }]);
  codex.turns[2].complete({ status: 'completed', text: '已批准' });
  await waitFor(() => approvalCard.snapshot.status === 'completed');
});
