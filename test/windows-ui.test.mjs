import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

test('Windows shows standard controls on the right and hides macOS traffic lights', async () => {
  const [html, renderer] = await Promise.all([
    readFile(resolve('src/ui/index.html'), 'utf8'),
    readFile(resolve('src/ui/renderer.ts'), 'utf8'),
  ]);
  const titlebar = html.slice(html.indexOf('<div class="fc-titlebar"'), html.indexOf('<div class="fc-layout"'));
  const windowsControls = titlebar.match(/<div class="fc-win-controls">([\s\S]*?)<\/div>/)?.[1];

  assert.match(renderer, /navigator\.platform\.startsWith\('Win'\).*classList\.add\('fc-native-win'\)/);
  assert.match(html, /html\.fc-native-win #fc-bridge-demo \.fc-traffic \{ display: none; \}/);
  assert.match(html, /html\.fc-native-win #fc-bridge-demo \.fc-win-controls \{ display: flex; \}/);
  assert.ok(titlebar.indexOf('fc-win-controls') > titlebar.indexOf('fc-version'));
  assert.ok(windowsControls);
  assert.deepEqual([...windowsControls.matchAll(/data-window-action="([^"]+)"/g)].map((match) => match[1]),
    ['minimize', 'maximize', 'close']);
  assert.match(html, /\.fc-win-controls button\[data-window-action="close"\]:hover \{ background: #e81123;/);
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

test('overview new-session button connects through the desktop IPC', async () => {
  const [html, renderer, preload, protocol, main] = await Promise.all([
    'src/ui/index.html', 'src/ui/renderer.ts', 'src/desktop/preload.ts',
    'src/desktop/protocol.ts', 'src/desktop/main.ts',
  ].map((file) => readFile(resolve(file), 'utf8')));
  const overview = html.slice(html.indexOf('data-panel="overview"'), html.indexOf('data-panel="settings"'));

  assert.match(overview, /data-action="stop"[^>]*>停止桥接<\/button>\s*<button[^>]*data-action="new-session">新建会话<\/button>/);
  assert.match(renderer, /\[data-action="new-session"\][\s\S]*?desktop\.newSession\(\)/);
  assert.match(protocol, /newSession\(\): Promise<DesktopSnapshot>/);
  assert.match(preload, /newSession: \(\) => ipcRenderer\.invoke\('bridge:new-session'\)/);
  assert.match(main, /ipcMain\.handle\('bridge:new-session'/);
});
