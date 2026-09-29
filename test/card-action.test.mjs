import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { buildSync } from 'esbuild';

const require = createRequire(import.meta.url);
const built = buildSync({
  stdin: {
    contents: [
      "export * from './src/core/lark.ts'",
      "export * from './src/core/card.ts'",
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
const { LarkCliTransport, buildLarkCard } = loaded.exports;

test('已接受按钮先 PATCH，随后用原 token 延时更新同版卡片', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-card-action-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const logPath = join(directory, 'calls.ndjson');
  const cliPath = join(directory, 'fake-lark-cli.cjs');
  await writeFile(cliPath, `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const args = process.argv.slice(2);
const file = args[args.indexOf('--data') + 1].slice(1);
const payload = JSON.parse(readFileSync(file, 'utf8'));
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, payload }) + '\\n');
process.stdout.write('{}');
`, { mode: 0o755 });

  const transport = new LarkCliTransport({
    cliPath, profile: 'offline-test', workDir: directory,
    settings: {
      appId: 'cli_test', allowedOpenIds: ['ou_owner'], allowedChatIds: ['oc_allowed'],
      workingDirectory: directory, allowGroupMentions: true,
      launchAtLogin: false, autoConnect: false,
    },
    log: () => {},
  });
  const original = {
    sessionId: 'om_input', ownerOpenId: 'ou_owner', prompt: '处理任务',
    status: 'question', question: { text: '继续吗？', options: ['继续'] }, version: 1,
  };
  const updated = { ...original, status: 'running', question: undefined, summary: '正在执行…', version: 2 };
  transport.cards.set('om_card', {
    chatId: 'oc_allowed', ownerOpenId: 'ou_owner', sessionId: 'om_input', snapshot: original,
  });
  transport.handlers = {
    onMessage: () => {},
    onAction: async (action) => {
      assert.equal(action.action, 'answer');
      assert.equal(action.value, '继续');
      await transport.updateCard(action.cardMessageId, updated);
    },
  };

  await transport.handleAction({
    type: 'card.action.trigger', action_tag: 'button', event_id: 'event_1',
    message_id: 'om_card', chat_id: 'oc_allowed', operator_id: 'ou_owner', token: 'callback_token',
    action_value: JSON.stringify({
      v: 1, action: 'question_answer', sessionId: 'om_input', cardVersion: 1, answer: '继续',
    }),
  });

  const calls = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(calls.map((call) => call.args.slice(2, 4)), [
    ['api', 'PATCH'], ['api', 'POST'],
  ]);
  assert.equal(calls[0].args[4], '/open-apis/im/v1/messages/om_card');
  assert.equal(calls[1].args[4], '/open-apis/interactive/v1/card/update');
  assert.deepEqual(JSON.parse(calls[0].payload.content), buildLarkCard(updated));
  assert.deepEqual(calls[1].payload, { token: 'callback_token', card: buildLarkCard(updated) });
  const button = calls[1].payload.card.body.elements.find((item) => item.tag === 'column_set');
  assert.equal(button.columns[0].elements[0].behaviors[0].value.cardVersion, 2);
});

test('运行卡片允许旧版本停止回调，提问和审批仍要求最新版本', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-card-version-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cliPath = join(directory, 'fake-lark-cli.cjs');
  await writeFile(cliPath, `#!/usr/bin/env node\nprocess.stdout.write('{}');\n`, { mode: 0o755 });

  const transport = new LarkCliTransport({
    cliPath, profile: 'offline-test', workDir: directory,
    settings: {
      appId: 'cli_test', allowedOpenIds: ['ou_owner'], allowedChatIds: ['oc_allowed'],
      workingDirectory: directory, allowGroupMentions: true,
      launchAtLogin: false, autoConnect: false,
    },
    log: () => {},
  });
  const received = [];
  transport.handlers = { onMessage: () => {}, onAction: (action) => received.push(action) };
  const snapshot = (sessionId, status, version) => ({
    sessionId, ownerOpenId: 'ou_owner', prompt: '处理任务', status, version,
  });
  const callback = (eventId, messageId, sessionId, action, version, answer) => ({
    type: 'card.action.trigger', action_tag: 'button', event_id: eventId,
    message_id: messageId, chat_id: 'oc_allowed', operator_id: 'ou_owner', token: `token-${eventId}`,
    action_value: JSON.stringify({ v: 1, action, sessionId, cardVersion: version, ...(answer ? { answer } : {}) }),
  });

  transport.cards.set('running-card', {
    chatId: 'oc_allowed', ownerOpenId: 'ou_owner', sessionId: 'session-running',
    snapshot: snapshot('session-running', 'running', 4),
  });
  transport.cards.set('question-card', {
    chatId: 'oc_allowed', ownerOpenId: 'ou_owner', sessionId: 'session-question',
    snapshot: snapshot('session-question', 'question', 4),
  });
  transport.cards.set('approval-card', {
    chatId: 'oc_allowed', ownerOpenId: 'ou_owner', sessionId: 'session-approval',
    snapshot: snapshot('session-approval', 'approval', 4),
  });
  transport.cards.set('completed-card', {
    chatId: 'oc_allowed', ownerOpenId: 'ou_owner', sessionId: 'session-completed',
    snapshot: snapshot('session-completed', 'completed', 4),
  });

  await transport.handleAction(callback('event-stop-wrong-session', 'running-card', 'session-other', 'stop_session', 2));
  await transport.handleAction(callback('event-stop-completed', 'completed-card', 'session-completed', 'stop_session', 2));
  await transport.handleAction(callback('event-stop-old', 'running-card', 'session-running', 'stop_session', 2));
  await transport.handleAction(callback('event-question-old', 'question-card', 'session-question', 'question_answer', 2, '继续'));
  await transport.handleAction(callback('event-approval-old', 'approval-card', 'session-approval', 'permission_allow', 2));

  assert.deepEqual(received, [{
    cardMessageId: 'running-card', actorOpenId: 'ou_owner', action: 'stop', version: 2,
  }]);
});
