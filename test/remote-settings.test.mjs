import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildSync, transformSync } from 'esbuild';
import test from 'node:test';

const require = createRequire(import.meta.url);

async function desktopHarness(directory) {
  const source = await readFile(resolve('src/desktop/main.ts'), 'utf8');
  const built = buildSync({
    stdin: {
      contents: `${source.replace('bridge = new Bridge({', 'bridge = new FakeBridge({')}\n
        class FakeBridge {
          constructor(options) { this.options = options; }
          async start() {}
          getStatus() { return { state: 'running', activeTurns: 0, queuedMessages: 0 }; }
          async updateSettings() {}
        }
        export const harness = { updateSettings, startBridge, seed(value) { saved = value; }, current() { return saved; },
          remote(...args) { return bridge.options.onSettingsChange(...args); } };`,
      resolveDir: resolve('src/desktop'), loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron'],
  });
  const loaded = { exports: {} };
  const electron = {
    app: { on() {}, whenReady: () => new Promise(() => {}), getPath: () => directory, getVersion: () => 'test', isPackaged: false },
  };
  new Function('require', 'module', 'exports', '__dirname', built.outputFiles[0].text)(
    (id) => id === 'electron' ? electron : require(id), loaded, loaded.exports, resolve('src/desktop'),
  );
  return loaded.exports.harness;
}

function savedSettings(directory) {
  return { ...snapshot().settings, workingDirectory: directory };
}

test('设置写盘失败时不更新内存，也不安排模型新会话', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-remote-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'settings.json'));
  const harness = await desktopHarness(directory);
  const original = {
    settings: savedSettings(directory),
    credentialsConfigured: true,
  };
  harness.seed(original);
  await assert.rejects(harness.updateSettings({ ...original.settings, model: 'new-model', appSecret: '' }));
  assert.equal(harness.current(), original);
  await assert.rejects(stat(join(directory, 'state', 'bridge-routes.json')), { code: 'ENOENT' });
});

test('串行保存先切换模型后拒绝旧模型的强度选择', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-remote-model-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const harness = await desktopHarness(directory);
  harness.seed({ settings: savedSettings(directory), credentialsConfigured: true });
  await harness.startBridge();
  const modelChange = harness.remote({ model: 'new-model' });
  const staleEffort = assert.rejects(harness.remote({ effort: 'low' }, 'old-model'), /模型已变化/);
  await modelChange;
  await staleEffort;
  assert.deepEqual([harness.current().settings.model, harness.current().settings.effort], ['new-model', 'high']);
  const persisted = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'));
  assert.equal(persisted.settings.effort, 'high');
});

async function rendererHarness(listModels = async () => []) {
  const source = await readFile(resolve('src/ui/renderer.ts'), 'utf8');
  const prefix = source.slice(0, source.indexOf("for (const button of root.querySelectorAll<HTMLButtonElement>('[data-page]'))"));
  const compiled = transformSync(`${prefix}\nfunction getHarness() { return { render, populateSettings, readSettings, loadModels }; }`, { loader: 'ts', target: 'es2022' }).code;
  class Element {
    constructor(id = '') { this.id = id; this.value = ''; this.options = []; this.dataset = {}; this.style = {}; }
    replaceChildren(...items) { this.options = items; this.value = items[0]?.value || ''; }
    add(item) { this.options.push(item); }
    append() {}
  }
  class Input extends Element {}
  const controls = ['app-id', 'app-secret', 'allowed-users', 'allowed-chats', 'session-timeout', 'model', 'effort',
    'group-mention', 'login-start', 'auto-connect'].map((id) => new Input(`fc-${id}`));
  for (const id of ['group-mention', 'login-start', 'auto-connect']) {
    const control = controls.find((item) => item.id === `fc-${id}`);
    control.type = 'checkbox';
    control.checked = false;
  }
  const elements = new Map(controls.map((control) => [`#${control.id}`, control]));
  const panel = new Element();
  panel.querySelectorAll = () => controls;
  elements.set('[data-panel="settings"]', panel);
  const root = new Element();
  root.querySelector = (selector) => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  const document = { getElementById: () => root, documentElement: { classList: { add() {} } }, createElement: () => new Element() };
  const api = new Function('document', 'navigator', 'window', 'HTMLInputElement', `${compiled}\nreturn getHarness();`)(
    document, { platform: 'test' }, { bridgeDesktop: { listModels } }, Input,
  );
  return { ...api, field: (id) => elements.get(`#fc-${id}`), saveButton: () => elements.get('[data-action="save"]') };
}

function snapshot(model = 'old-model', effort = 'high') {
  return {
    version: 'test', credentialsConfigured: true, logs: [], status: { state: 'running', activeTurns: 0, queuedMessages: 0 },
    settings: {
      appId: 'cli_test', allowedOpenIds: ['ou_owner'], allowedChatIds: [], model, effort,
      sessionTimeoutHours: 24, allowGroupMentions: false, launchAtLogin: false, autoConnect: false,
    },
  };
}

test('远程模型和强度快照同步不清除其他未保存表单内容', async () => {
  const ui = await rendererHarness();
  ui.populateSettings(snapshot());
  ui.render(snapshot());
  ui.render(snapshot('new-model', 'max'));
  assert.equal(ui.saveButton().disabled, true);
  ui.field('app-secret').value = 'unsaved-secret';
  ui.field('allowed-users').value = 'ou_owner\nou_added';
  ui.render(snapshot('new-model', 'low'));
  const input = ui.readSettings();
  assert.deepEqual([input.model, input.effort], ['new-model', 'low']);
  assert.equal(input.appSecret, 'unsaved-secret');
  assert.deepEqual(input.allowedOpenIds, ['ou_owner', 'ou_added']);
  assert.equal(ui.saveButton().disabled, false);
});

test('模型列表加载期间收到远程设置，加载完成后保留新设置', async () => {
  let resolveModels;
  const ui = await rendererHarness(() => new Promise((resolvePromise) => { resolveModels = resolvePromise; }));
  ui.populateSettings(snapshot());
  ui.render(snapshot());
  const loading = ui.loadModels();
  ui.render(snapshot('new-model', 'max'));
  resolveModels(['old-model', 'new-model'].map((id) => ({
    id, displayName: id, defaultReasoningEffort: 'high',
    reasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'max' }],
  })));
  await loading;
  assert.deepEqual([ui.field('model').value, ui.field('effort').value], ['new-model', 'max']);
});
