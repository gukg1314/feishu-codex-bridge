import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Tray } from 'electron';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { release } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Bridge } from '../core/bridge';
import { CodexClient } from '../core/codex';
import { LarkCliTransport } from '../core/lark';
import { RouteStore } from '../core/routes';
import type { BridgeSettings, BridgeStatus } from '../core/types';
import type { DesktopSnapshot, LogEntry, SettingsInput } from './protocol';
import { defaultSettings, loadSettings, saveSettings, validateSettings, type SavedSettings } from './settings';
import { shouldShowOnStartup } from './startup-window';
import { decideWindowClose } from './window-close';

const profile = 'bridge';
const stopped: BridgeStatus = { state: 'stopped', activeTurns: 0, queuedMessages: 0 };
let saved: SavedSettings;
let status: BridgeStatus = stopped;
let bridge: Bridge | undefined;
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
let closeDialogOpen = false;
let windowContentsReady = false;
let logs: LogEntry[] = [];
let operations: Promise<unknown> = Promise.resolve();

function dataPath(name: string): string {
  return path.join(app.getPath('userData'), name);
}

function binaryPath(name: 'codex' | 'lark-cli'): string {
  const executable = process.platform === 'win32' ? `${name}.exe` : name;
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bin', executable)
    : path.resolve(__dirname, '../../build/bin', executable);
}

function redact(message: string): string {
  return message
    .replace(/\b(ou_|oc_|om_|cli_)([A-Za-z0-9_-]{8,})\b/g, (_whole, prefix: string, id: string) => `${prefix}…${id.slice(-4)}`)
    .replace(/(app[_ -]?secret|authorization|access[_ -]?token)\s*[:=]\s*\S+/gi, '$1=[已脱敏]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [已脱敏]');
}

function snapshot(): DesktopSnapshot {
  const current = saved ?? defaultSettings();
  const safeStatus = status.lastError ? { ...status, lastError: redact(status.lastError) } : status;
  return { version: app.getVersion(), settings: current.settings, credentialsConfigured: current.credentialsConfigured, status: safeStatus, logs: [...logs] };
}

function publish(): void {
  if (window && !window.isDestroyed()) window.webContents.send('bridge:snapshot', snapshot());
  updateTray();
}

function recordLog(level: LogEntry['level'], message: string): void {
  const entry = { time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), level, message: redact(message) };
  logs.unshift(entry);
  if (logs.length > 200) logs.length = 200;
  void appendFile(dataPath('bridge.log'), `${JSON.stringify(entry)}\n`, { mode: 0o600 }).catch(() => {});
  publish();
}

async function reportStartupFailure(error: unknown): Promise<void> {
  const reason = redact(error instanceof Error ? error.message : String(error));
  const detail = redact(error instanceof Error ? error.stack ?? error.message : String(error));
  console.error(`[启动] 客户端启动失败：${detail}`);
  let logPath = '';
  try {
    logPath = dataPath('bridge.log');
    await mkdir(path.dirname(logPath), { recursive: true });
    const entry: LogEntry = { time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), level: 'ERROR', message: `客户端启动失败：${detail}` };
    await appendFile(logPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch (logError) {
    console.error('[启动] 写入运行日志失败：', logError);
  }
  dialog.showErrorBox('飞书桥接Codex 启动失败', `${reason}\n\n详细信息请查看：${logPath || '运行日志'}`);
  app.quit();
}

async function restoreLogs(): Promise<void> {
  try {
    const content = await readFile(dataPath('bridge.log'), 'utf8');
    logs = content.trim().split('\n').slice(-200).reverse().flatMap((line) => {
      try {
        const entry = JSON.parse(line) as LogEntry;
        return ['INFO', 'WARN', 'ERROR'].includes(entry.level) ? [{ ...entry, message: redact(entry.message) }] : [];
      } catch { return []; }
    });
  } catch { /* A new installation has no log file. */ }
}

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const result = operations.then(task, task);
  operations = result.catch(() => {});
  return result;
}

async function userOperation<T>(name: string, task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    recordLog('ERROR', `${name}失败：${error instanceof Error ? error.message : '未知错误'}`);
    throw error;
  }
}

function ensureReady(): void {
  if (!saved.settings.appId || !saved.credentialsConfigured) throw new Error('请先保存飞书 App ID 和 App Secret');
  if (!saved.settings.allowedOpenIds.length) throw new Error('请先填写允许使用的成员 open_id');
}

async function startBridge(): Promise<void> {
  if (status.state === 'running' || status.state === 'starting') return;
  ensureReady();
  if (bridge) await bridge.stop().catch(() => {});
  await mkdir(dataPath('bridge-files'), { recursive: true });
  await mkdir(dataPath('state'), { recursive: true });
  const settings = saved.settings;
  const lark = new LarkCliTransport({
    cliPath: binaryPath('lark-cli'), profile, settings,
    workDir: dataPath('bridge-files'),
    log: (level, message) => recordLog(level.toUpperCase() as LogEntry['level'], message)
  });
  const codex = new CodexClient({ binaryPath: binaryPath('codex'), version: app.getVersion(), log: recordLog });
  bridge = new Bridge({
    settings, lark, codex, storageDir: dataPath('state'), log: recordLog,
    onStatus: (next) => { status = next; publish(); },
    onSettingsChange: (patch, expectedModel) => serialize(async () => {
      if (expectedModel !== undefined && expectedModel !== saved.settings.model) {
        throw new Error('模型已变化，请重新发送推理强度指令');
      }
      await updateSettings({ ...saved.settings, ...patch, appSecret: '' });
      recordLog('INFO', `飞书设置已同步：模型 ${saved.settings.model}，推理强度 ${saved.settings.effort || '默认'}`);
    })
  });
  try {
    await bridge.start();
    status = bridge.getStatus();
    recordLog('INFO', '桥接已启动；已沿用保存的执行目录');
  } catch (error) {
    status = { state: 'error', activeTurns: 0, queuedMessages: 0, lastError: '启动失败' };
    recordLog('ERROR', `桥接启动失败：${error instanceof Error ? error.message : '未知错误'}`);
    throw new Error('桥接启动失败，请查看运行日志');
  }
  publish();
}

async function stopBridge(): Promise<void> {
  if (!bridge) {
    status = stopped;
    publish();
    return;
  }
  await bridge.stop();
  bridge = undefined;
  status = stopped;
  recordLog('INFO', '桥接已停止');
  publish();
}

async function requestStopBridge(): Promise<void> {
  if (status.activeTurns > 0 || status.queuedMessages > 0) {
    const options: Electron.MessageBoxOptions = {
      type: 'question', title: '停止桥接', message: '将中断当前任务并清空排队消息。',
      buttons: ['取消', '停止桥接'], defaultId: 0, cancelId: 0, noLink: true
    };
    recordLog('INFO', `停止桥接确认已显示：处理中 ${status.activeTurns}，排队 ${status.queuedMessages}`);
    const result = window && !window.isDestroyed() && window.isVisible()
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options);
    if (result.response !== 1) {
      recordLog('INFO', '已取消停止桥接');
      return;
    }
  }
  await stopBridge();
}

async function requestNewSession(reason: string): Promise<void> {
  if (bridge && status.state === 'running') {
    await bridge.requestNewSession(reason);
  } else {
    const store = new RouteStore(dataPath('state'));
    await store.load();
    await store.requestNewSession();
    recordLog('INFO', `已安排新会话（${reason}）：每个聊天的下一条飞书指令将新建 Codex 会话`);
  }
}

async function configureCredentials(appId: string, appSecret: string): Promise<void> {
  const child = spawn(binaryPath('lark-cli'), [
    'config', 'init', '--name', profile, '--app-id', appId,
    '--app-secret-stdin', '--brand', 'feishu'
  ], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  child.stdin.on('error', () => {});
  child.stdin.end(appSecret);
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? -1));
  });
  if (exitCode !== 0) throw new Error(`保存飞书凭据失败（退出码 ${exitCode}）`);
  recordLog('INFO', '飞书凭据已保存到独立 CLI 配置');
}

function applyLoginItem(settings: BridgeSettings): void {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin });
}

function applyDockVisibility(settings: BridgeSettings): void {
  const dock = app.dock;
  if (process.platform !== 'darwin' || !dock) return;
  const policy = settings.hideDockIcon ? 'accessory' : 'regular';
  app.setActivationPolicy(policy);
  if (window && !window.isDestroyed() && window.isVisible()) showWindow();
  const hidden = !dock.isVisible();
  recordLog(hidden === settings.hideDockIcon ? 'INFO' : 'WARN',
    `Mac 程序坞设置已应用：模式 ${policy}，隐藏${settings.hideDockIcon ? '开启' : '关闭'}，图标${hidden ? '不可见' : '可见'}`);
}

async function updateSettings(input: SettingsInput): Promise<DesktopSnapshot> {
  const next = await validateSettings(input, saved.settings.workingDirectory);
  const secretChanged = input.appSecret.length > 0;
  if ((next.appId !== saved.settings.appId || !saved.credentialsConfigured) && !secretChanged) {
    throw new Error('首次设置或更换 App ID 时，请填写 App Secret');
  }
  if (secretChanged) await configureCredentials(next.appId, input.appSecret);
  const previous = saved.settings;
  const wasRunning = status.state === 'running';
  const modelChanged = previous.model !== next.model;
  const connectionChanged = secretChanged || previous.appId !== next.appId ||
    previous.workingDirectory !== next.workingDirectory ||
    previous.allowGroupMentions !== next.allowGroupMentions ||
    JSON.stringify(previous.allowedOpenIds) !== JSON.stringify(next.allowedOpenIds) ||
    JSON.stringify(previous.allowedChatIds) !== JSON.stringify(next.allowedChatIds);
  const nextSaved = { settings: next, credentialsConfigured: saved.credentialsConfigured || secretChanged };
  await saveSettings(dataPath('settings.json'), nextSaved);
  saved = nextSaved;
  try {
    applyLoginItem(next);
    if (previous.hideDockIcon !== next.hideDockIcon) applyDockVisibility(next);
    if (modelChanged && (!wasRunning || connectionChanged)) await requestNewSession('模型切换');
    if (wasRunning && connectionChanged) {
      await stopBridge();
      await startBridge();
    } else if (wasRunning) {
      await bridge?.updateSettings(next);
    }
  } catch (error) {
    recordLog('ERROR', `设置已保存，但桥接应用失败：${error instanceof Error ? error.message : '未知错误'}`);
    throw new Error('设置已保存，但桥接应用失败，请查看日志并重新启动桥接');
  }
  recordLog('INFO', '设置已更新 · 敏感字段已脱敏');
  publish();
  return snapshot();
}

function showWindow(): void {
  if (!window || window.isDestroyed()) return;
  window.show();
  window.focus();
}

async function requestWindowClose(): Promise<void> {
  const currentWindow = window;
  if (quitting || closeDialogOpen || !currentWindow || currentWindow.isDestroyed()) return;
  closeDialogOpen = true;
  try {
    const action = await decideWindowClose(process.platform, async (options) => {
      recordLog('INFO', 'Windows 关闭确认已显示');
      const result = await dialog.showMessageBox(currentWindow, { type: 'question', noLink: true, ...options });
      return result.response;
    });
    if (quitting) return;
    if (action === 'quit') {
      recordLog('INFO', '窗口关闭选择：关闭工具');
      app.quit();
    } else {
      currentWindow.hide();
      if (process.platform === 'win32') recordLog('INFO', '窗口关闭选择：最小化到托盘，桥接继续运行');
    }
  } catch (error) {
    recordLog('ERROR', `窗口关闭确认失败：${error instanceof Error ? error.message : '未知错误'}`);
  } finally {
    closeDialogOpen = false;
  }
}

function updateTray(): void {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `桥接：${status.state === 'running' ? '运行中' : status.state === 'starting' ? '启动中' : '已停止'}`, enabled: false },
    { label: '显示窗口', click: showWindow },
    { type: 'separator' },
    { label: '启动桥接', enabled: status.state === 'stopped' || status.state === 'error', click: () => { void serialize(() => userOperation('托盘启动桥接', startBridge)).catch(() => {}); } },
    { label: '停止桥接', enabled: status.state === 'running', click: () => { void serialize(() => userOperation('托盘停止桥接', requestStopBridge)).catch(() => {}); } },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]));
}

function applyWindowMaterial(): void {
  if (!window || window.isDestroyed() || !windowContentsReady) return;
  const mac = process.platform === 'darwin';
  // Mica 仅在 Windows 11 22H2 起稳定支持，旧系统保留浅色实底。
  const windowsMica = process.platform === 'win32' && Number(release().split('.')[2]) >= 22621;
  const reduced = nativeTheme.prefersReducedTransparency;
  let material = !reduced && (mac || windowsMica);
  try {
    if (mac) window.setVibrancy(material ? 'under-window' : null);
    if (windowsMica) window.setBackgroundMaterial(material ? 'mica' : 'none');
    window.setBackgroundColor(material ? '#00000000' : '#f5f5fa');
    recordLog('INFO', `窗口材质已应用：${material ? mac ? 'Mac 磨砂' : 'Windows Mica' : '浅色实底'}${reduced ? '（系统已减少透明度）' : ''}`);
  } catch (error) {
    material = false;
    window.setBackgroundColor('#f5f5fa');
    recordLog('WARN', `窗口材质已回退浅色：${error instanceof Error ? error.message : '未知错误'}`);
  }
  const platformClass = mac ? 'fc-native-mac' : process.platform === 'win32' ? 'fc-native-win' : 'fc-native-other';
  void window.webContents.executeJavaScript(`(() => {
    const root = document.documentElement;
    root.classList.add('${platformClass}');
    root.classList.toggle('fc-material', ${material});
    return { revision: getComputedStyle(root).getPropertyValue('--fc-visual-revision').trim(), width: innerWidth, height: innerHeight };
  })()`)
    .then(({ revision, width, height }) => recordLog('INFO', `界面光影已同步：${revision}，内容区域 ${width}×${height}`))
    .catch((error) => recordLog('WARN', `窗口材质样式同步失败：${error instanceof Error ? error.message : '未知错误'}`));
}

function createWindow(): void {
  const nativeMacTitleBar = process.platform === 'darwin';
  const windowIcon = process.platform === 'win32' ? 'macdock.png' : 'main.png';
  const wasOpenedAtLogin = app.getLoginItemSettings().wasOpenedAtLogin;
  const showImmediately = shouldShowOnStartup(process.platform, wasOpenedAtLogin);
  window = new BrowserWindow({
    width: 1080, height: 730, minWidth: 760, minHeight: 650,
    frame: true, titleBarStyle: nativeMacTitleBar ? 'hiddenInset' : undefined,
    visualEffectState: nativeMacTitleBar ? 'followWindow' : undefined,
    show: showImmediately, backgroundColor: '#f5f5fa',
    icon: app.isPackaged
      ? path.join(process.resourcesPath, windowIcon)
      : path.resolve(__dirname, `../../icon/${windowIcon}`),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false
    }
  });
  window.on('close', (event) => {
    if (!quitting) { event.preventDefault(); void requestWindowClose(); }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('dom-ready', () => { windowContentsReady = true; applyWindowMaterial(); });
  void window.loadFile(path.resolve(__dirname, '../ui/index.html')).catch(reportStartupFailure);
  window.once('ready-to-show', () => {
    if (!wasOpenedAtLogin) showWindow();
  });
  if (showImmediately) recordLog('INFO', 'Windows 主窗口已创建并显示');
}

function createTray(): void {
  const windows = process.platform === 'win32';
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, windows ? 'macdock.png' : 'bar.png')
    : path.resolve(__dirname, windows ? '../../icon/macdock.png' : '../../icon/bar.png');
  const source = nativeImage.createFromPath(iconPath);
  const icon = windows
    ? source.resize({ width: 32, height: 32 })
    : source.crop({ x: 497, y: 263, width: 545, height: 474 }).resize({ height: 18 });
  tray = new Tray(icon);
  tray.setToolTip('飞书桥接Codex');
  tray.on('click', showWindow);
  updateTray();
  recordLog('INFO', windows ? 'Windows 托盘已就绪，可从托盘恢复窗口' : '托盘已就绪');
}

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void serialize(stopBridge).finally(() => app.quit());
});
app.on('activate', showWindow);

void app.whenReady().then(async () => {
  app.setName('飞书桥接Codex');
  nativeTheme.themeSource = 'light';
  await mkdir(app.getPath('userData'), { recursive: true });
  saved = await loadSettings(dataPath('settings.json'));
  await restoreLogs();
  applyLoginItem(saved.settings);

  ipcMain.handle('bridge:get-snapshot', () => snapshot());
  ipcMain.handle('bridge:list-models', () => userOperation('读取模型列表', async () => {
    const client = new CodexClient({ binaryPath: binaryPath('codex'), version: app.getVersion(), log: recordLog });
    await client.start();
    try {
      return await client.listModels();
    } finally {
      await client.stop();
    }
  }));
  ipcMain.handle('bridge:save-settings', (_event, input: SettingsInput) => serialize(() => userOperation('保存设置', () => updateSettings(input))));
  ipcMain.handle('bridge:start', () => serialize(() => userOperation('启动桥接', async () => { await startBridge(); return snapshot(); })));
  ipcMain.handle('bridge:stop', () => serialize(() => userOperation('停止桥接', async () => { await requestStopBridge(); return snapshot(); })));
  ipcMain.handle('bridge:new-session', () => serialize(() => userOperation('新建会话', async () => { await requestNewSession('手动点击'); return snapshot(); })));
  applyDockVisibility(saved.settings);
  createWindow();
  nativeTheme.on('updated', applyWindowMaterial);
  createTray();
  recordLog('INFO', '桌面客户端已启动');

  if (saved.settings.autoConnect) {
    void serialize(startBridge).catch(() => {});
  }
}).catch(reportStartupFailure);
