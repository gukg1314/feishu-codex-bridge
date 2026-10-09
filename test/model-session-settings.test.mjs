import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildSync } from 'esbuild';
import test from 'node:test';

const require = createRequire(import.meta.url);

function loadTypeScript(entry) {
  const built = buildSync({ entryPoints: [resolve(entry)], bundle: true, platform: 'node', format: 'cjs', write: false });
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports);
  return loaded.exports;
}

const { CodexClient } = loadTypeScript('src/core/codex.ts');
const { RouteStore } = loadTypeScript('src/core/routes.ts');
const { defaultSettings, loadSettings, saveSettings, validateSettings } = loadTypeScript('src/desktop/settings.ts');

test('Codex 模型目录分页并解析显示名、默认强度和支持的强度', async () => {
  const requests = [];
  const client = new CodexClient({ binaryPath: 'unused', log: () => {} });
  client.request = async (method, params) => {
    requests.push({ method, params });
    if (!params.cursor) return {
      data: [
        {
          model: 'gpt-6-astra', displayName: 'Astra', description: '旗舰模型', hidden: true,
          isDefault: false, defaultReasoningEffort: 'high',
          supportedReasoningEfforts: [
            { reasoningEffort: 'high', description: '高' },
            { reasoningEffort: 12, description: '无效项' },
            { reasoningEffort: 'max' },
          ],
        },
        { model: 12 },
      ],
      nextCursor: 'page-2',
    };
    return { data: [{ model: 'gpt-6-sol', isDefault: true }] };
  };

  const models = await client.listModels();
  assert.deepEqual(requests, [
    { method: 'model/list', params: { includeHidden: true } },
    { method: 'model/list', params: { includeHidden: true, cursor: 'page-2' } },
  ]);
  assert.deepEqual(models, [
    {
      id: 'gpt-6-astra', displayName: 'Astra', description: '旗舰模型', hidden: true, isDefault: false,
      defaultReasoningEffort: 'high',
      reasoningEfforts: [{ reasoningEffort: 'high', description: '高' }, { reasoningEffort: 'max', description: '' }],
    },
    {
      id: 'gpt-6-sol', displayName: 'gpt-6-sol', description: '', hidden: false, isDefault: true,
      defaultReasoningEffort: '', reasoningEfforts: [],
    },
  ]);
});

test('线程和 turn 请求使用所选模型与权限参数', async () => {
  const requests = [];
  const client = new CodexClient({ binaryPath: 'unused', log: () => {} });
  client.request = async (method, params) => {
    requests.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'thread-1' } };
    if (method === 'turn/start') return { turn: { id: 'turn-1' } };
    return {};
  };

  assert.equal(await client.startThread('/tmp/work', 'gpt-6-sol', 'max'), 'thread-1');
  await client.resumeThread('thread-1', '/tmp/work', 'gpt-6-sol', 'max');
  const events = {
    onProgress() {}, onQuestion() {}, onApproval() {},
  };
  await client.startTurn('thread-1', '继续', [], '/tmp/work', events, 'gpt-6-sol', 'max');
  await client.startTurn('thread-2', '自动选择强度', [], '/tmp/work', events, 'gpt-6-mini', '');

  assert.deepEqual(requests[0], {
    method: 'thread/start',
    params: { cwd: '/tmp/work', model: 'gpt-6-sol', approvalPolicy: 'never', sandbox: 'danger-full-access', serviceName: 'feishu_codex_bridge' },
  });
  assert.deepEqual(requests[1], {
    method: 'thread/resume',
    params: { threadId: 'thread-1', cwd: '/tmp/work', model: 'gpt-6-sol', approvalPolicy: 'never', sandbox: 'danger-full-access', excludeTurns: true },
  });
  assert.deepEqual(requests[2].params, {
    threadId: 'thread-1', cwd: '/tmp/work', input: [{ type: 'text', text: '继续', text_elements: [] }],
    model: 'gpt-6-sol', effort: 'max', approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' }, summary: 'auto',
  });
  assert.equal('effort' in requests[3].params, false);
});

test('旧设置补齐默认值，保存设置时沿用已有工作目录', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-settings-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const defaults = defaultSettings();
  assert.equal(defaults.settings.model, 'gpt-6-sol');
  assert.equal(defaults.settings.effort, 'max');
  assert.equal(defaults.settings.sessionTimeoutHours, 24);
  assert.equal(defaults.settings.hideDockIcon, false);

  const settingsFile = join(directory, 'settings.json');
  await writeFile(settingsFile, JSON.stringify({
    credentialsConfigured: true,
    settings: {
      appId: 'cli_legacy', allowedOpenIds: ['ou_owner'], allowedChatIds: ['oc_allowed'],
      workingDirectory: directory, allowGroupMentions: true, launchAtLogin: false, autoConnect: false,
    },
  }));
  const migrated = await loadSettings(settingsFile);
  assert.equal(migrated.settings.hideDockIcon, false);
  assert.deepEqual(
    [migrated.settings.model, migrated.settings.effort, migrated.settings.sessionTimeoutHours],
    ['gpt-6-sol', 'max', 24],
  );

  const validInput = {
    appId: ' cli_new ', appSecret: 'secret', allowedOpenIds: ['ou_owner'], allowedChatIds: ['oc_allowed'],
    model: ' gpt-6-astra ', effort: ' high ', sessionTimeoutHours: 12,
    allowGroupMentions: false, launchAtLogin: false, autoConnect: false, hideDockIcon: false,
  };
  const validated = await validateSettings({ ...validInput, workingDirectory: tmpdir() }, ` ${directory}/. `);
  assert.equal(validated.workingDirectory, resolve(directory));
  assert.deepEqual([validated.model, validated.effort, validated.sessionTimeoutHours], ['gpt-6-astra', 'high', 12]);
  assert.equal(validated.hideDockIcon, false);
  const hidden = await validateSettings({ ...validInput, hideDockIcon: true }, directory);
  await saveSettings(settingsFile, { settings: hidden, credentialsConfigured: true });
  assert.equal((await loadSettings(settingsFile)).settings.hideDockIcon, true);
  await assert.rejects(validateSettings({ ...validInput, hideDockIcon: 'true' }, directory), /开关设置格式/);
  await assert.rejects(validateSettings({ ...validInput, sessionTimeoutHours: 1.5 }, directory), /会话超时/);
});

test('旧字符串路线迁移为带最后活跃时间的路线记录', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-route-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'bridge-routes.json');
  const routeKey = JSON.stringify(['oc_allowed', 'ou_owner']);
  await writeFile(file, JSON.stringify({ routes: { [routeKey]: 'legacy-thread' }, seen: ['seen-message'] }));

  const beforeLoad = Date.now();
  const store = new RouteStore(directory);
  await store.load();
  const migratedAt = store.getThread('oc_allowed', 'ou_owner').lastActiveAt;
  assert.equal(store.getThread('oc_allowed', 'ou_owner').threadId, 'legacy-thread');
  assert.ok(migratedAt >= beforeLoad && migratedAt <= Date.now());
  assert.equal(store.hasSeen('seen-message'), true);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(saved.routes[routeKey], { threadId: 'legacy-thread', lastActiveAt: migratedAt });
});

test('全局新会话请求持久化，原路线和去重记录保留', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-route-reset-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'bridge-routes.json');
  const firstKey = JSON.stringify(['oc_first', 'ou_owner']);
  const secondKey = JSON.stringify(['oc_second', 'ou_owner']);
  await writeFile(file, JSON.stringify({
    routes: {
      [firstKey]: { threadId: 'first-thread', lastActiveAt: Date.now() },
      [secondKey]: { threadId: 'second-thread', lastActiveAt: Date.now() },
    },
    seen: ['om_seen'],
  }));

  const store = new RouteStore(directory);
  await store.load();
  await store.requestNewSession();
  const reloaded = new RouteStore(directory);
  await reloaded.load();
  assert.equal(reloaded.getSessionGeneration(), 1);
  assert.equal(reloaded.getThread('oc_first', 'ou_owner').threadId, 'first-thread');
  assert.equal(reloaded.getThread('oc_second', 'ou_owner').threadId, 'second-thread');
  assert.equal(reloaded.hasSeen('om_seen'), true);

  await reloaded.setThread('oc_first', 'ou_owner', 'new-first-thread');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.routes[firstKey].sessionGeneration, 1);
  assert.equal(saved.routes[secondKey].threadId, 'second-thread');
  assert.deepEqual(saved.seen, ['om_seen']);
});

test('路线写盘失败保留旧线程和会话代次', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-route-failure-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new RouteStore(directory);
  await store.setThread('oc_first', 'ou_owner', 'old-thread');
  store.save = async () => { throw new Error('写盘失败'); };
  await assert.rejects(store.setThread('oc_first', 'ou_owner', 'new-thread'), /写盘失败/);
  await assert.rejects(store.requestNewSession(), /写盘失败/);
  assert.equal(store.getThread('oc_first', 'ou_owner').threadId, 'old-thread');
  assert.equal(store.getSessionGeneration(), 0);
});
