import { build } from 'esbuild';
import { copyFile, cp, mkdir } from 'node:fs/promises';

await mkdir('dist/desktop', { recursive: true });
await mkdir('dist/ui', { recursive: true });

await Promise.all([
  build({
    entryPoints: ['src/desktop/main.ts'],
    outfile: 'dist/desktop/main.cjs',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    sourcemap: true
  }),
  build({
    entryPoints: ['src/desktop/preload.ts'],
    outfile: 'dist/desktop/preload.cjs',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron']
  }),
  build({
    entryPoints: ['src/ui/renderer.ts'],
    outfile: 'dist/ui/renderer.js',
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome130'
  }),
  copyFile('src/ui/index.html', 'dist/ui/index.html'),
  cp('src/ui/assets', 'dist/ui/assets', { recursive: true })
]);
