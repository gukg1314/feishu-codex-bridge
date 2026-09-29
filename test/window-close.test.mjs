import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { buildSync } from 'esbuild';

const require = createRequire(import.meta.url);
const built = buildSync({
  entryPoints: [resolve('src/desktop/window-close.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
});
const loaded = { exports: {} };
new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports);
const { decideWindowClose, windowsCloseDialog } = loaded.exports;

const startupBuilt = buildSync({
  entryPoints: [resolve('src/desktop/startup-window.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
});
const startupLoaded = { exports: {} };
new Function('require', 'module', 'exports', startupBuilt.outputFiles[0].text)(require, startupLoaded, startupLoaded.exports);
const { shouldShowOnStartup } = startupLoaded.exports;

test('Windows normal startup shows the window immediately; login launch and macOS keep hidden startup', () => {
  assert.equal(shouldShowOnStartup('win32', false), true);
  assert.equal(shouldShowOnStartup('win32', true), false);
  assert.equal(shouldShowOnStartup('darwin', false), false);
});

test('Windows X and in-app close choices map to hide or quit', async () => {
  const seen = [];
  assert.equal(await decideWindowClose('win32', async (options) => {
    seen.push(options);
    return 0;
  }), 'hide');
  assert.equal(await decideWindowClose('win32', async (options) => {
    seen.push(options);
    return 1;
  }), 'quit');
  assert.deepEqual(seen, [windowsCloseDialog, windowsCloseDialog]);
  assert.equal(windowsCloseDialog.buttons.length, 2);
  assert.equal(windowsCloseDialog.defaultId, 0);
  assert.equal(windowsCloseDialog.cancelId, 0);
});

test('macOS close keeps the native hide behavior without showing a dialog', async () => {
  let shown = false;
  assert.equal(await decideWindowClose('darwin', async () => {
    shown = true;
    return 1;
  }), 'hide');
  assert.equal(shown, false);
});
