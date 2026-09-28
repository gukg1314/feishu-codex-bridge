import { app, BrowserWindow, ipcMain, Menu, nativeImage, Tray } from 'electron';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Bridge } from '../core/bridge';
import { CodexClient } from '../core/codex';
import { LarkCliTransport } from '../core/lark';
import type { BridgeSettings, BridgeStatus } from '../core/types';
import type { DesktopSnapshot, LogEntry, SettingsInput } from './protocol';
import { defaultSettings, loadSettings, saveSettings, validateSettings, type SavedSettings } from './settings';

const profile = 'bridge';
const stopped: BridgeStatus = { state: 'stopped', activeTurns: 0, queuedMessages: 0 };
let saved: SavedSettings;
let status: BridgeStatus = stopped;
let bridge: Bridge | undefined;
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
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
  return { settings: current.settings, credentialsConfigured: current.credentialsConfigured, status: safeStatus, logs: [...logs] };
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
  const codex = new CodexClient({ binaryPath: binaryPath('codex'), log: recordLog });
  bridge = new Bridge({
    settings, lark, codex, storageDir: dataPath('state'), log: recordLog,
    onStatus: (next) => { status = next; publish(); }
  });
  try {
    await bridge.start();
    status = bridge.getStatus();
    recordLog('INFO', '桥接已启动');
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

async function updateSettings(input: SettingsInput): Promise<DesktopSnapshot> {
  const next = await validateSettings(input);
  const secretChanged = input.appSecret.length > 0;
  if ((next.appId !== saved.settings.appId || !saved.credentialsConfigured) && !secretChanged) {
    throw new Error('首次设置或更换 App ID 时，请填写 App Secret');
  }
  if (secretChanged) await configureCredentials(next.appId, input.appSecret);
  const previous = saved.settings;
  const wasRunning = status.state === 'running';
  saved = { settings: next, credentialsConfigured: saved.credentialsConfigured || secretChanged };
  await saveSettings(dataPath('settings.json'), saved);
  applyLoginItem(next);
  recordLog('INFO', '设置已更新 · 敏感字段已脱敏');

  const connectionChanged = secretChanged || previous.appId !== next.appId ||
    previous.workingDirectory !== next.workingDirectory ||
    previous.allowGroupMentions !== next.allowGroupMentions ||
    JSON.stringify(previous.allowedOpenIds) !== JSON.stringify(next.allowedOpenIds) ||
    JSON.stringify(previous.allowedChatIds) !== JSON.stringify(next.allowedChatIds);
  if (wasRunning && connectionChanged) {
    await stopBridge();
    await startBridge();
  }
  publish();
  return snapshot();
}

function showWindow(): void {
  if (!window || window.isDestroyed()) return;
  window.show();
  window.focus();
}

function updateTray(): void {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `桥接：${status.state === 'running' ? '运行中' : status.state === 'starting' ? '启动中' : '已停止'}`, enabled: false },
    { label: '显示窗口', click: showWindow },
    { type: 'separator' },
    { label: '启动桥接', enabled: status.state === 'stopped' || status.state === 'error', click: () => { void serialize(startBridge).catch(() => {}); } },
    { label: '停止桥接', enabled: status.state === 'running', click: () => { void serialize(stopBridge).catch(() => {}); } },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]));
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1080, height: 730, minWidth: 760, minHeight: 650,
    frame: false, show: false, backgroundColor: '#ffffff',
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'main.png')
      : path.resolve(__dirname, '../../icon/main.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false
    }
  });
  window.on('close', (event) => {
    if (!quitting) { event.preventDefault(); window?.hide(); }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  void window.loadFile(path.resolve(__dirname, '../ui/index.html'));
  window.once('ready-to-show', () => {
    if (!app.getLoginItemSettings().wasOpenedAtLogin) showWindow();
  });
}

function createTray(): void {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'bar.png')
    : path.resolve(__dirname, '../../icon/bar.png');
  const icon = nativeImage.createFromPath(iconPath)
    .crop({ x: 497, y: 263, width: 545, height: 474 })
    .resize({ height: 18 });
  tray = new Tray(icon);
  tray.setToolTip('飞书桥接Codex');
  tray.on('click', showWindow);
  updateTray();
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
  await mkdir(app.getPath('userData'), { recursive: true });
  saved = await loadSettings(dataPath('settings.json'));
  await restoreLogs();
  applyLoginItem(saved.settings);

  ipcMain.handle('bridge:get-snapshot', () => snapshot());
  ipcMain.handle('bridge:save-settings', (_event, input: SettingsInput) => serialize(() => updateSettings(input)));
  ipcMain.handle('bridge:start', () => serialize(async () => { await startBridge(); return snapshot(); }));
  ipcMain.handle('bridge:stop', () => serialize(async () => { await stopBridge(); return snapshot(); }));
  ipcMain.handle('bridge:window-action', (_event, action: string) => {
    if (action === 'close') window?.hide();
    else if (action === 'minimize') window?.minimize();
    else if (action === 'maximize') window?.isMaximized() ? window.unmaximize() : window?.maximize();
  });

  createWindow();
  createTray();
  recordLog('INFO', '桌面客户端已启动');

  if (saved.settings.autoConnect) {
    void serialize(startBridge).catch(() => {});
  }
}).catch((error) => {
  recordLog('ERROR', `客户端初始化失败：${error instanceof Error ? error.message : '未知错误'}`);
  app.quit();
});
