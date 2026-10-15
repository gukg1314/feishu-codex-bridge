import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildSync, transformSync } from 'esbuild';
import test from 'node:test';

const require = createRequire(import.meta.url);

async function desktopHarness(directory, platform = process.platform, systemRelease = '10.0.22621') {
  const source = await readFile(resolve('src/desktop/main.ts'), 'utf8');
  const built = buildSync({
    stdin: {
      contents: `${source.replace('bridge = new Bridge({', 'bridge = new FakeBridge({')
        .replace('void app.whenReady().then(', 'const ready = app.whenReady().then(')}\n
        const bridgeCalls = { starts: 0, stops: 0, updates: 0, newSessions: 0 };
        class FakeBridge {
          constructor(options) { this.options = options; }
          async start() { bridgeCalls.starts++; }
          async stop() { bridgeCalls.stops++; }
          async requestNewSession() { bridgeCalls.newSessions++; }
          getStatus() { return { state: 'running', activeTurns: 0, queuedMessages: 0 }; }
          async updateSettings() { bridgeCalls.updates++; }
        }
        export const harness = { ready, bridgeCalls, snapshot, updateSettings, startBridge, seed(value) { saved = value; }, current() { return saved; },
          remote(...args) { return bridge.options.onSettingsChange(...args); }, requestStopBridge, setStatus(value) { status = value; } };`,
      resolveDir: resolve('src/desktop'), loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron'],
  });
  const loaded = { exports: {} };
  const dockCalls = { checks: 0 };
  const policies = [];
  const lifecycle = [];
  const windowCalls = { vibrancy: [], materials: [], backgrounds: [], scripts: [] };
  const dialogCalls = [];
  let dockVisible = platform !== 'darwin';
  let rejectNextPolicy = false;
  let rejectNextMaterial = false;
  let reducedTransparency = false;
  let dialogResponse = 0;
  let resolveReady;
  let nativeWindow;
  let menu;
  const themeListeners = [];
  const webContentsListeners = [];
  const ready = new Promise((resolvePromise) => { resolveReady = resolvePromise; });
  const image = { crop() { return this; }, resize() { return this; } };
  const nativeTheme = {
    themeSource: 'system',
    get prefersReducedTransparency() { return reducedTransparency; },
    on(event, listener) { if (event === 'updated') themeListeners.push(listener); },
  };
  const electron = {
    app: {
      on() {}, whenReady: () => ready, getPath: () => directory, getVersion: () => 'test', isPackaged: false,
      setName() {}, getLoginItemSettings: () => ({}),
      setActivationPolicy(policy) {
        policies.push(policy);
        lifecycle.push(policy);
        if (!rejectNextPolicy) dockVisible = policy === 'regular';
        rejectNextPolicy = false;
      },
      dock: {
        isVisible() { dockCalls.checks++; return dockVisible; },
      },
    },
    ipcMain: { handle() {} },
    dialog: {
      async showMessageBox(...args) { dialogCalls.push(args.at(-1)); return { response: dialogResponse }; },
      showErrorBox() {},
    },
    nativeTheme,
    BrowserWindow: class extends EventEmitter {
      constructor(options) {
        super();
        lifecycle.push('window');
        nativeWindow = this;
        this.visible = options.show;
        this.webContents = {
          send() {}, setWindowOpenHandler() {},
          on(event, listener) { if (event === 'dom-ready') webContentsListeners.push(listener); },
          emit(event) { if (event === 'dom-ready') webContentsListeners.forEach((listener) => listener()); },
          executeJavaScript(script) { windowCalls.scripts.push(script); return Promise.resolve(); },
        };
      }
      isDestroyed() { return false; } isVisible() { return this.visible; } loadFile() { return Promise.resolve(); }
      show() { this.visible = true; } focus() { this.focused = true; }
      setVibrancy(value) { windowCalls.vibrancy.push(value); }
      setBackgroundMaterial(value) {
        windowCalls.materials.push(value);
        if (rejectNextMaterial) { rejectNextMaterial = false; throw new Error('材质不可用'); }
      }
      setBackgroundColor(value) { windowCalls.backgrounds.push(value); }
    },
    Tray: class { constructor() { lifecycle.push('tray'); } setToolTip() {} on() {} setContextMenu(value) { menu = value; } },
    Menu: { buildFromTemplate: (value) => value },
    nativeImage: { createFromPath: () => image },
  };
  new Function('require', 'module', 'exports', '__dirname', 'process', built.outputFiles[0].text)(
    (id) => id === 'electron' ? electron : id === 'node:os' ? { ...require(id), release: () => systemRelease } : require(id), loaded, loaded.exports, resolve('src/desktop'),
    Object.create(process, { platform: { value: platform } }),
  );
  return {
    ...loaded.exports.harness, dockCalls, policies, lifecycle, windowCalls, dialogCalls, dockVisible: () => dockVisible,
    menu: () => menu, nativeWindow: () => nativeWindow,
    rejectNextDockPolicy: () => { rejectNextPolicy = true; },
    rejectNextWindowMaterial: () => { rejectNextMaterial = true; },
    setReducedTransparency: (value) => { reducedTransparency = value; },
    updateNativeTheme: () => themeListeners.forEach((listener) => listener()),
    setDialogResponse: (value) => { dialogResponse = value; },
    boot: async () => { resolveReady(); await loaded.exports.harness.ready; nativeWindow.webContents.emit('dom-ready'); },
  };
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
  harness.seed({ settings: { ...savedSettings(directory), hideDockIcon: true }, credentialsConfigured: true });
  await harness.startBridge();
  const modelChange = harness.remote({ model: 'new-model' });
  const staleEffort = assert.rejects(harness.remote({ effort: 'low' }, 'old-model'), /模型已变化/);
  await modelChange;
  await staleEffort;
  assert.deepEqual([harness.current().settings.model, harness.current().settings.effort], ['new-model', 'high']);
  const persisted = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'));
  assert.equal(persisted.settings.effort, 'high');
  assert.equal(persisted.settings.hideDockIcon, true);
  assert.deepEqual(harness.policies, []);
  assert.deepEqual(harness.dockCalls, { checks: 0 });
});

test('Mac 程序坞启动包声明为菜单栏应用', async () => {
  const packageInfo = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  assert.equal(packageInfo.build.mac.extendInfo.LSUIElement, true);
});

test('Mac 程序坞开关即时切换、重启恢复，菜单栏可显示窗口且不重连或新建会话', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-dock-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const harness = await desktopHarness(directory, 'darwin');
  harness.seed({ settings: savedSettings(directory), credentialsConfigured: true });
  await harness.startBridge();
  for (const hidden of [true, false, true]) {
    await harness.updateSettings({ ...harness.current().settings, appSecret: '', hideDockIcon: hidden });
  }
  await harness.remote({ effort: 'max' }, 'old-model');
  assert.deepEqual(harness.policies, ['accessory', 'regular', 'accessory']);
  assert.equal(harness.dockVisible(), false);
  assert.deepEqual(harness.bridgeCalls, { starts: 1, stops: 0, updates: 4, newSessions: 0 });
  assert.equal(harness.current().settings.hideDockIcon, true);

  const restarted = await desktopHarness(directory, 'darwin');
  await restarted.boot();
  assert.equal(restarted.current().settings.hideDockIcon, true);
  assert.equal(restarted.dockVisible(), false);
  assert.deepEqual(restarted.lifecycle, ['accessory', 'window', 'tray']);
  restarted.nativeWindow().emit('ready-to-show');
  restarted.menu().find((item) => item.label === '显示窗口').click();
  assert.equal(restarted.nativeWindow().visible, true);
  assert.equal(restarted.nativeWindow().focused, true);
  assert.equal(restarted.dockVisible(), false);
  assert.ok(JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')).settings.hideDockIcon);
  restarted.nativeWindow().focused = false;
  await restarted.updateSettings({ ...restarted.current().settings, appSecret: '', hideDockIcon: false });
  assert.deepEqual(restarted.policies, ['accessory', 'regular']);
  assert.equal(restarted.dockVisible(), true);
  assert.equal(restarted.nativeWindow().visible, true);
  assert.equal(restarted.nativeWindow().focused, true);
});

test('Mac 程序坞默认关闭，新安装和旧配置在创建窗口前恢复普通应用', async (t) => {
  for (const legacy of [false, true]) {
    const directory = await mkdtemp(join(tmpdir(), 'feishu-dock-default-mode-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    if (legacy) {
      const settings = savedSettings(directory);
      delete settings.hideDockIcon;
      await writeFile(join(directory, 'settings.json'), JSON.stringify({ settings, credentialsConfigured: true }));
    }
    const harness = await desktopHarness(directory, 'darwin');
    assert.equal(harness.dockVisible(), false);
    await harness.boot();
    assert.equal(harness.current().settings.hideDockIcon, false);
    assert.deepEqual(harness.lifecycle, ['regular', 'window', 'tray']);
    assert.equal(harness.dockVisible(), true);
    assert.ok(harness.snapshot().logs.some((entry) => entry.message.includes('模式 regular，隐藏关闭，图标可见')));
  }
});

test('Mac 程序坞模式切换未成功时记录实际状态警告', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-dock-policy-rejected-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const harness = await desktopHarness(directory, 'darwin');
  harness.rejectNextDockPolicy();
  await harness.boot();
  const entry = harness.snapshot().logs.find((item) => item.message.includes('程序坞设置已应用'));
  assert.equal(entry.level, 'WARN');
  assert.match(entry.message, /模式 regular，隐藏关闭，图标不可见/);
});

test('Windows 程序坞设置不调用 Mac 原生接口', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-dock-windows-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const harness = await desktopHarness(directory, 'win32');
  harness.seed({ settings: savedSettings(directory), credentialsConfigured: true });
  await harness.updateSettings({ ...harness.current().settings, appSecret: '', hideDockIcon: true });
  await harness.boot();
  assert.deepEqual(harness.policies, []);
  assert.deepEqual(harness.dockCalls, { checks: 0 });
});

test('停止确认取消时保留桥接和当前任务', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-stop-cancel-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const harness = await desktopHarness(directory);
  harness.seed({ settings: savedSettings(directory), credentialsConfigured: true });
  await harness.startBridge();
  harness.setStatus({ state: 'running', activeTurns: 2, queuedMessages: 1 });
  harness.setDialogResponse(0);

  await harness.requestStopBridge();

  assert.equal(harness.bridgeCalls.stops, 0);
  assert.deepEqual(harness.snapshot().status, { state: 'running', activeTurns: 2, queuedMessages: 1 });
  assert.deepEqual(harness.dialogCalls[0].buttons, ['取消', '停止桥接']);
  assert.deepEqual([harness.dialogCalls[0].defaultId, harness.dialogCalls[0].cancelId], [0, 0]);
  assert.ok(harness.snapshot().logs.some((entry) => entry.message === '已取消停止桥接'));
});

test('Windows 11 材质随系统透明度设置回退，原生应用失败时改用浅色实底', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-window-material-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const harness = await desktopHarness(directory, 'win32', '10.0.22621');
  harness.seed({ settings: { ...savedSettings(directory), hideDockIcon: false }, credentialsConfigured: true });
  await harness.boot();

  assert.equal(harness.windowCalls.materials[0], 'mica');
  assert.equal(harness.windowCalls.backgrounds[0], '#00000000');
  assert.match(harness.windowCalls.scripts[0], /fc-native-win/);
  assert.match(harness.windowCalls.scripts[0], /toggle\('fc-material', true\)/);
  assert.equal(harness.nativeWindow().visible, true);

  harness.setReducedTransparency(true);
  harness.updateNativeTheme();
  assert.equal(harness.windowCalls.materials.at(-1), 'none');
  assert.equal(harness.windowCalls.backgrounds.at(-1), '#f5f5fa');
  assert.match(harness.windowCalls.scripts.at(-1), /toggle\('fc-material', false\)/);

  harness.setReducedTransparency(false);
  harness.rejectNextWindowMaterial();
  harness.updateNativeTheme();
  assert.equal(harness.windowCalls.backgrounds.at(-1), '#f5f5fa');
  assert.ok(harness.snapshot().logs.some((entry) => entry.level === 'WARN' && entry.message.includes('窗口材质已回退浅色')));
});

async function rendererHarness(listModels = async () => [], platform = 'test') {
  const source = await readFile(resolve('src/ui/renderer.ts'), 'utf8');
  const prefix = source.slice(0, source.indexOf("for (const button of root.querySelectorAll<HTMLButtonElement>('[data-page]'))"));
  const compiled = transformSync(`${prefix}\nfunction getHarness() { return { render, populateSettings, readSettings, loadModels, showPage, action, filter(level) { logFilter = level; renderFullLogs(); } }; }`, { loader: 'ts', target: 'es2022' }).code;
  class Element {
    constructor(id = '') { this.id = id; this.value = ''; this.options = []; this.children = []; this.dataset = {}; this.style = {}; this.attributes = new Map(); }
    replaceChildren(...items) { this.children = items; this.options = items; this.value = items[0]?.value || ''; }
    add(item) { this.options.push(item); }
    append(...items) { this.children.push(...items); }
    setAttribute(name, value) { this.attributes.set(name, value); }
    removeAttribute(name) { this.attributes.delete(name); }
    focus() { this.focused = true; }
  }
  class Input extends Element {}
  const controls = ['app-id', 'app-secret', 'allowed-users', 'allowed-chats', 'session-timeout', 'model', 'effort',
    'group-mention', 'login-start', 'auto-connect', 'hide-dock'].map((id) => new Input(`fc-${id}`));
  for (const id of ['group-mention', 'login-start', 'auto-connect', 'hide-dock']) {
    const control = controls.find((item) => item.id === `fc-${id}`);
    control.type = 'checkbox';
    control.checked = false;
  }
  const elements = new Map(controls.map((control) => [`#${control.id}`, control]));
  elements.set('[data-settings-fields]', new Element());
  const panels = ['overview', 'settings', 'logs'].map((page) => {
    const panel = new Element();
    panel.dataset.panel = page;
    panel.hidden = page !== 'overview';
    if (page === 'settings') panel.querySelectorAll = () => controls;
    return panel;
  });
  elements.set('[data-panel="settings"]', panels[1]);
  const pageButtons = ['overview', 'settings', 'logs'].map((page) => {
    const button = new Element();
    button.dataset.page = page;
    return button;
  });
  const logFilters = ['all', 'INFO', 'WARN', 'ERROR'].map((level) => {
    const button = new Element();
    button.dataset.logFilter = level;
    return button;
  });
  const root = new Element();
  root.dataset = {};
  root.querySelector = (selector) => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  root.querySelectorAll = (selector) => selector === '[data-page]' ? pageButtons
    : selector === '[data-panel]' ? panels : selector === '[data-log-filter]' ? logFilters : [];
  const document = { getElementById: () => root, documentElement: { classList: { add() {} } }, createElement: () => new Element() };
  const api = new Function('document', 'navigator', 'window', 'HTMLInputElement', `${compiled}\nreturn getHarness();`)(
    document, { platform }, { bridgeDesktop: { listModels } }, Input,
  );
  return { ...api, field: (id) => elements.get(`#fc-${id}`), saveButton: () => elements.get('[data-action="save"]'),
    dockSetting: () => elements.get('[data-dock-setting]'), panel: (page) => panels.find((item) => item.dataset.panel === page),
    root: () => root, statusTitle: () => elements.get('[data-status-title]'), activeTurns: () => elements.get('[data-active-turns]'),
    queuedMessages: () => elements.get('[data-queued-messages]'), notice: () => elements.get('[data-ui-notice]'),
    noticeMessage: () => elements.get('[data-ui-message]'), groupFields: () => elements.get('#fc-group-fields'),
    settingsFields: () => elements.get('[data-settings-fields]'),
    fullLogMessages: () => elements.get('[data-full-logs]').children.map((line) => line.children[2]?.textContent) };
}

function snapshot(model = 'old-model', effort = 'high') {
  return {
    version: 'test', credentialsConfigured: true, logs: [], status: { state: 'running', activeTurns: 0, queuedMessages: 0 },
    settings: {
      appId: 'cli_test', allowedOpenIds: ['ou_owner'], allowedChatIds: [], model, effort,
      sessionTimeoutHours: 24, allowGroupMentions: false, launchAtLogin: false, autoConnect: false, hideDockIcon: false,
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
  ui.field('hide-dock').checked = true;
  ui.render(snapshot('new-model', 'low'));
  const input = ui.readSettings();
  assert.deepEqual([input.model, input.effort], ['new-model', 'low']);
  assert.equal(input.appSecret, 'unsaved-secret');
  assert.deepEqual(input.allowedOpenIds, ['ou_owner', 'ou_added']);
  assert.equal(input.hideDockIcon, true);
  assert.equal(ui.saveButton().disabled, false);
});

test('程序坞开关仅在 Mac 显示，加载和读取设置并参与保存状态', async () => {
  for (const platform of ['MacIntel', 'Win32']) {
    const ui = await rendererHarness(undefined, platform);
    const initial = snapshot();
    ui.populateSettings(initial);
    ui.render(initial);
    assert.equal(ui.dockSetting().hidden, platform !== 'MacIntel');
    assert.equal(ui.readSettings().hideDockIcon, false);
    ui.field('hide-dock').checked = true;
    ui.render(initial);
    assert.equal(ui.readSettings().hideDockIcon, true);
    assert.equal(ui.saveButton().disabled, false);
    const saved = { ...initial, settings: { ...initial.settings, hideDockIcon: true } };
    ui.populateSettings(saved);
    ui.render(saved);
    assert.equal(ui.field('hide-dock').checked, true);
    assert.equal(ui.saveButton().disabled, true);
  }
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

test('总览显示真实状态和计数，错误提示留在当前页', async () => {
  const ui = await rendererHarness();
  const initial = snapshot();
  ui.populateSettings(initial);
  ui.showPage('settings');
  ui.render({
    ...initial,
    status: { state: 'error', activeTurns: 3, queuedMessages: 5, lastError: 'Codex 执行失败' },
  });

  assert.equal(ui.root().dataset.state, 'error');
  assert.equal(ui.statusTitle().textContent, '发生错误');
  assert.equal(ui.activeTurns().textContent, '3');
  assert.equal(ui.queuedMessages().textContent, '5');
  assert.equal(ui.panel('settings').hidden, false);
  assert.equal(ui.notice().hidden, false);
  assert.equal(ui.noticeMessage().textContent, 'Codex 执行失败');
});

test('日志按所选级别过滤', async () => {
  const ui = await rendererHarness();
  const initial = snapshot();
  const logs = [
    { time: '10:00:00', level: 'INFO', message: '已启动' },
    { time: '10:01:00', level: 'WARN', message: '连接较慢' },
    { time: '10:02:00', level: 'ERROR', message: '连接失败' },
  ];
  ui.populateSettings(initial);
  ui.render({ ...initial, logs });
  assert.deepEqual(ui.fullLogMessages(), ['已启动', '连接较慢', '连接失败']);

  ui.filter('ERROR');

  assert.deepEqual(ui.fullLogMessages(), ['连接失败']);
});

test('首次配置或更换 App ID 要求密钥，关闭群聊后仍保留已保存群聊 ID', async () => {
  const ui = await rendererHarness();
  const firstRun = snapshot();
  firstRun.credentialsConfigured = false;
  ui.populateSettings(firstRun);
  ui.render(firstRun);
  assert.equal(ui.field('app-secret').required, true);

  const saved = {
    ...snapshot(),
    settings: { ...snapshot().settings, allowGroupMentions: false, allowedChatIds: ['oc_saved_chat'] },
  };
  ui.populateSettings(saved);
  ui.render(saved);
  assert.equal(ui.field('app-secret').required, false);
  assert.equal(ui.groupFields().hidden, true);
  assert.deepEqual(ui.readSettings().allowedChatIds, ['oc_saved_chat']);

  ui.field('app-id').value = 'cli_changed';
  ui.render(saved);
  assert.equal(ui.field('app-secret').required, true);
});

test('保存期间锁定设置字段，保存完成后恢复且不再标记未保存', async () => {
  const ui = await rendererHarness();
  const initial = snapshot();
  ui.populateSettings(initial);
  ui.render(initial);
  ui.field('app-id').value = 'cli_changed';
  ui.render(initial);
  assert.equal(ui.saveButton().disabled, false);

  let finishSave;
  const saving = ui.action(async () => {
    const result = await new Promise((resolvePromise) => { finishSave = resolvePromise; });
    ui.populateSettings(result);
    return result;
  }, 'save');
  assert.equal(ui.settingsFields().disabled, true);
  assert.equal(ui.saveButton().disabled, true);
  finishSave(initial);
  await saving;

  assert.equal(ui.settingsFields().disabled, false);
  assert.equal(ui.saveButton().disabled, true);
  assert.equal(ui.field('app-id').value, initial.settings.appId);
});

test('保存错误优先定位到具体的 App Secret 字段', async () => {
  const ui = await rendererHarness();
  const initial = snapshot();
  ui.populateSettings(initial);
  ui.render(initial);

  await ui.action(async () => { throw new Error('App Secret 无效；App ID 格式错误'); }, 'save');

  assert.equal(ui.field('app-secret').focused, true);
  assert.equal(ui.field('app-secret').attributes.get('aria-invalid'), 'true');
  assert.equal(ui.field('app-id').focused, undefined);
});
