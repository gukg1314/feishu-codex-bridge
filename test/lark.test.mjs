import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { buildSync } from 'esbuild';

const require = createRequire(import.meta.url);
const built = buildSync({
  stdin: {
    contents: [
      "export * from './src/core/attachments.ts'",
      "export * from './src/core/card.ts'",
      "export * from './src/core/lark.ts'",
    ].join('\n'),
    resolveDir: resolve('.'),
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
});
const loaded = { exports: {} };
new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports);
const { normalizeLarkInboundEvent, hydrateLarkMessage, normalizeLarkCardAction, buildLarkCard } = loaded.exports;

const settings = {
  appId: 'cli_test',
  allowedOpenIds: ['ou_owner'],
  allowedChatIds: ['oc_allowed'],
  workingDirectory: '/tmp',
  allowGroupMentions: true,
  launchAtLogin: false,
  autoConnect: false,
};
const base = {
  type: 'im.message.receive_v1',
  message_id: 'om_input',
  chat_id: 'oc_allowed',
  sender_id: 'ou_owner',
  sender_type: 'user',
  chat_type: 'group',
  message_type: 'post',
  content: '查看 [文档](https://example.com)',
  mentions: [{ id: 'ou_bot' }],
};

test('群聊同时要求成员、群 ID、@ 机器人，并保留链接', () => {
  const accepted = normalizeLarkInboundEvent(base, settings, 'ou_bot');
  assert.equal(accepted?.text, base.content);
  assert.equal(accepted?.mentionsBot, true);
  assert.equal(normalizeLarkInboundEvent({ ...base, sender_id: 'ou_other' }, settings, 'ou_bot'), null);
  assert.equal(normalizeLarkInboundEvent({ ...base, chat_id: 'oc_other' }, settings, 'ou_bot'), null);
  assert.equal(normalizeLarkInboundEvent({ ...base, mentions: [] }, settings, 'ou_bot'), null);
  assert.equal(normalizeLarkInboundEvent(base, { ...settings, allowGroupMentions: false }, 'ou_bot'), null);
  assert.equal(normalizeLarkInboundEvent({ ...base, chat_type: 'p2p', chat_id: 'oc_dm', mentions: [] }, settings, 'ou_bot')?.chatType, 'p2p');
});

test('图片、Excel、音视频资源传本地路径，富文本链接保留', () => {
  const incoming = normalizeLarkInboundEvent({ ...base, chat_type: 'p2p', content: '' }, settings, 'ou_bot');
  assert.ok(incoming);
  const hydrated = hydrateLarkMessage({ messages: [{
    message_id: 'om_input',
    msg_type: 'post',
    content: JSON.stringify({ zh_cn: { content: [[{ tag: 'a', text: '表格', href: 'https://example.com/x' }]] } }),
    resources: [
      { type: 'image', local_path: './lark-im-resources/picture.png' },
      { type: 'file', local_path: './lark-im-resources/data.xlsx' },
      { type: 'file', local_path: './lark-im-resources/voice.opus' },
      { type: 'file', local_path: './lark-im-resources/movie.mp4' },
    ],
  }] }, incoming, '/tmp/bridge-test');
  assert.equal(hydrated.text, '[表格](https://example.com/x)');
  assert.deepEqual(hydrated.attachments.map((item) => [item.kind, item.name]), [
    ['image', 'picture.png'], ['file', 'data.xlsx'], ['file', 'voice.opus'], ['file', 'movie.mp4'],
  ]);
});

test('媒体键不作为提问文字，回复消息 ID 来自 reply_to', () => {
  const incoming = normalizeLarkInboundEvent({
    ...base, chat_type: 'p2p', message_type: 'image', content: '{"image_key":"img_123"}',
    reply_to: 'om_card',
  }, settings, 'ou_bot');
  assert.ok(incoming);
  assert.equal(incoming.text, '');
  assert.equal(incoming.replyToMessageId, 'om_card');
  const hydrated = hydrateLarkMessage({ messages: [{
    message_id: 'om_input', msg_type: 'image', content: '{"image_key":"img_123"}',
    resources: [{ type: 'image', local_path: './lark-im-resources/picture.png' }],
  }] }, incoming, '/tmp/bridge-test');
  assert.equal(hydrated.text, 'picture.png');
  assert.equal(hydrated.replyToMessageId, 'om_card');
});

test('卡片沿用引用、状态、按钮和带版本的回调', () => {
  const snapshot = {
    sessionId: 'session', ownerOpenId: 'ou_owner', prompt: '处理 Excel',
    status: 'running', version: 2, details: ['读取文件'],
  };
  const card = buildLarkCard(snapshot);
  assert.equal(card.schema, '2.0');
  assert.equal(card.body.elements[0].content, '> 处理 Excel');
  assert.equal(card.body.elements[1].tag, 'collapsible_panel');
  const buttons = card.body.elements.find((item) => item.tag === 'column_set');
  const value = buttons.columns[0].elements[0].behaviors[0].value;
  assert.deepEqual(value, { v: 1, action: 'stop_session', sessionId: 'session', cardVersion: 2 });
  const action = normalizeLarkCardAction({
    type: 'card.action.trigger', action_tag: 'button', event_id: 'evt1',
    message_id: 'om_card', chat_id: 'oc_allowed', operator_id: 'ou_owner', token: 'callback_token',
    action_value: JSON.stringify(value),
  });
  assert.equal(action?.action, 'stop');
  assert.equal(action?.version, 2);
  assert.equal(action?.callbackToken, 'callback_token');
  const groupQuestion = buildLarkCard({ ...snapshot, chatType: 'group', status: 'question', question: { text: '继续吗？' } });
  assert.match(groupQuestion.body.elements.map((item) => item.content ?? '').join('\n'), /回复这条飞书消息，并 @ 机器人/);
});
