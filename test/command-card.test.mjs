import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { buildSync } from 'esbuild';

const require = createRequire(import.meta.url);
const built = buildSync({
  stdin: {
    contents: "export * from './src/core/card.ts'; export * from './src/core/lark.ts';",
    resolveDir: resolve('.'), loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'cjs', write: false,
});
const loaded = { exports: {} };
new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports);
const { buildLarkCard, normalizeLarkCardAction, LarkCliTransport } = loaded.exports;
const snapshot = {
  sessionId: 'menu-1', ownerOpenId: 'ou_owner', chatType: 'group',
  prompt: '/切换模型', status: 'control', version: 2,
  control: {
    title: '选择模型', detail: '当前模型：model-0', page: 1, pages: 3,
    options: Array.from({ length: 7 }, (_, i) => ({ label: `GPT-6.1-Sol-${i}（当前模型完整名称）`, value: `model-${i}` })),
  },
};
const buttons = (card) => card.body.elements.flatMap((item) => item.tag === 'button' ? [item]
  : item.tag === 'column_set' ? item.columns.flatMap((column) => column.elements) : []);
const callback = (eventId, action, answer, patch = {}) => ({
  type: 'card.action.trigger', action_tag: 'button', event_id: eventId,
  message_id: 'om_menu', chat_id: 'oc_allowed', operator_id: 'ou_owner', token: 'token-1',
  action_value: {
    v: 1, action, sessionId: 'menu-1', cardVersion: 2,
    ...(answer !== undefined ? { answer } : {}),
  },
  ...patch,
});

test('控制卡片单列全宽展示完整名称，保留分页和取消', () => {
  const card = buildLarkCard(snapshot);
  assert.ok(card.body.elements.some((item) => item.content?.includes('选择模型')));
  assert.ok(card.body.elements.some((item) => item.content?.includes('当前模型：model-0')));
  const choices = card.body.elements.filter((item) => item.tag === 'button');
  assert.equal(choices.length, snapshot.control.options.length);
  assert.ok(choices.every((item) => item.width === 'fill'));
  assert.deepEqual(choices.map((item) => item.text.content), snapshot.control.options.map((item) => item.label));
  const values = buttons(card).map((item) => item.behaviors[0].value);
  assert.deepEqual(values.filter((value) => value.action === 'command_select').map((value) => value.answer),
    snapshot.control.options.map((option) => option.value));
  assert.deepEqual(values.filter((value) => value.action === 'command_page').map((value) => value.answer), ['0', '2']);
  assert.deepEqual(values.at(-1), { v: 1, action: 'command_cancel', sessionId: 'menu-1', cardVersion: 2 });
  for (const page of [0, 2]) {
    const edge = buildLarkCard({ ...snapshot, control: { ...snapshot.control, page } });
    assert.deepEqual(buttons(edge).filter((item) => item.behaviors[0].value.action === 'command_page')
      .map((item) => item.text.content), [page === 0 ? '下一页' : '上一页']);
  }
  const busy = buildLarkCard({ ...snapshot, control: { ...snapshot.control, busy: true } });
  assert.equal(buttons(busy).length, 0);
  assert.equal(busy.config.summary.content, 'Codex · 正在处理');
  const cancelled = buildLarkCard({ ...snapshot, status: 'stopped', summary: '已取消' });
  assert.ok(cancelled.body.elements.some((item) => item.content?.includes('已取消')));
  assert.equal(buttons(buildLarkCard({ ...snapshot, status: 'completed', summary: '已取消' })).length, 0);
});

test('控制回调识别选择、翻页、取消，选择和翻页必须带非空值', () => {
  for (const [action, normalized, answer] of [
    ['command_select', 'select', 'model-0'], ['command_page', 'page', '0'], ['command_cancel', 'cancel'],
  ]) {
    const event = normalizeLarkCardAction(callback(`event-${action}`, action, answer));
    assert.equal(event?.action, normalized);
    assert.equal(event?.value, answer);
  }
  for (const action of ['command_select', 'command_page']) {
    assert.equal(normalizeLarkCardAction(callback('event-empty', action, '  ')), null);
  }
});

test('控制回调要求最新卡片、拥有者、会话、当前权限并去重', async () => {
  const settings = {
    appId: 'cli_test', allowedOpenIds: ['ou_owner'], allowedChatIds: ['oc_allowed'],
    workingDirectory: '.', model: 'model-0', effort: 'high', sessionTimeoutHours: 24,
    allowGroupMentions: true, launchAtLogin: false, autoConnect: false,
  };
  const transport = new LarkCliTransport({
    cliPath: 'unused', profile: 'offline', workDir: '.', settings, log: () => {},
  });
  const received = [];
  transport.handlers = { onMessage: () => {}, onAction: (action) => received.push(action) };
  const setCard = (card = snapshot) => transport.cards.set('om_menu', {
    chatId: 'oc_allowed', ownerOpenId: 'ou_owner', sessionId: 'menu-1', snapshot: card,
  });
  setCard();
  await transport.handleAction(callback('wrong-owner', 'command_select', 'model-0', { operator_id: 'ou_other' }));
  await transport.handleAction(callback('wrong-chat', 'command_select', 'model-0', { chat_id: 'oc_other' }));
  await transport.handleAction(callback('wrong-session', 'command_select', 'model-0', {
    action_value: { v: 1, action: 'command_select', sessionId: 'other', cardVersion: 2, answer: 'model-0' },
  }));
  await transport.handleAction(callback('old-version', 'command_select', 'model-0', {
    action_value: { v: 1, action: 'command_select', sessionId: 'menu-1', cardVersion: 1, answer: 'model-0' },
  }));
  setCard({ ...snapshot, status: 'running' });
  await transport.handleAction(callback('wrong-status', 'command_cancel'));
  setCard({ ...snapshot, control: { ...snapshot.control, busy: true } });
  await transport.handleAction(callback('busy', 'command_cancel'));
  setCard();
  for (const patch of [
    { allowedOpenIds: [] }, { allowedChatIds: [] }, { allowGroupMentions: false },
  ]) {
    transport.updateSettings({ ...settings, ...patch });
    await transport.handleAction(callback(`revoked-${Object.keys(patch)[0]}`, 'command_select', 'model-0'));
  }
  assert.equal(received.length, 0);
  transport.updateSettings(settings);
  for (const [action, answer] of [['command_select', 'model-0'], ['command_page', '0'], ['command_cancel']]) {
    transport.usedCardVersions.clear();
    await transport.handleAction(callback(`accepted-${action}`, action, answer));
    await transport.handleAction(callback(`accepted-${action}`, action, answer));
    await transport.handleAction(callback(`repeated-${action}`, action, answer));
  }
  assert.deepEqual(received.map((action) => [action.action, action.value]), [
    ['select', 'model-0'], ['page', '0'], ['cancel', undefined],
  ]);
});
