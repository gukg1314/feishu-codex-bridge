import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

test('Windows keeps the native frame and removes the custom macOS titlebar', async () => {
  const [html, renderer, main, protocol, preload] = await Promise.all([
    readFile(resolve('src/ui/index.html'), 'utf8'),
    readFile(resolve('src/ui/renderer.ts'), 'utf8'),
    readFile(resolve('src/desktop/main.ts'), 'utf8'),
    readFile(resolve('src/desktop/protocol.ts'), 'utf8'),
    readFile(resolve('src/desktop/preload.ts'), 'utf8'),
  ]);
  const titlebar = html.slice(html.indexOf('<header class="fc-titlebar"'), html.indexOf('<div class="fc-layout"'));

  assert.match(renderer, /navigator\.platform\.startsWith\('Win'\).*classList\.add\('fc-native-win'\)/);
  assert.match(html, /html\.fc-native-win \.fc-titlebar \{ display: none; \}/);
  assert.match(main, /frame: true/);
  assert.match(main, /titleBarStyle: nativeMacTitleBar \? 'hiddenInset' : undefined/);
  assert.match(titlebar, /<span class="fc-title">[\s\S]*<span class="fc-version">/);
  assert.doesNotMatch(html, /fc-win-controls|fc-traffic|data-window-action=/);
  assert.doesNotMatch(protocol, /windowAction/);
  assert.doesNotMatch(preload, /bridge:window-action/);
});

test('Windows executable and runtime icons use the macOS Dock artwork', async () => {
  const [packageInfo, main] = await Promise.all([
    readFile(resolve('package.json'), 'utf8').then(JSON.parse),
    readFile(resolve('src/desktop/main.ts'), 'utf8'),
  ]);
  const { mac, win } = packageInfo.build;

  assert.equal(win.icon, mac.icon);
  assert.notEqual(win.signAndEditExecutable, false);
  assert.deepEqual(win.extraResources, [{ from: mac.icon, to: 'macdock.png' }]);
  assert.match(main, /const windowIcon = process\.platform === 'win32' \? 'macdock\.png' : 'main\.png'/);
  assert.match(main, /windows \? 'macdock\.png' : 'bar\.png'/);
  const icon = await readFile(resolve(win.icon));
  assert.deepEqual(icon.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
});

test('overview status and new-session action remain connected to the desktop IPC', async () => {
  const [html, renderer, preload, protocol, main] = await Promise.all([
    'src/ui/index.html', 'src/ui/renderer.ts', 'src/desktop/preload.ts',
    'src/desktop/protocol.ts', 'src/desktop/main.ts',
  ].map((file) => readFile(resolve(file), 'utf8')));
  const overview = html.slice(html.indexOf('data-panel="overview"'), html.indexOf('data-panel="settings"'));

  assert.match(overview, /data-status-title/);
  assert.match(overview, /data-active-turns/);
  assert.match(overview, /data-queued-messages/);
  assert.match(overview, /data-action="new-session"[^>]*>新建会话<\/button>/);
  assert.match(renderer, /\[data-action="new-session"\][\s\S]*?desktop\.newSession\(\)/);
  assert.match(protocol, /newSession\(\): Promise<DesktopSnapshot>/);
  assert.match(preload, /newSession: \(\) => ipcRenderer\.invoke\('bridge:new-session'\)/);
  assert.match(main, /ipcMain\.handle\('bridge:new-session'/);
});
