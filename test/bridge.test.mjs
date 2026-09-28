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

async function waitFor(check) {
  for (let attempt = 0; attempt < 200; attempt++) {
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
