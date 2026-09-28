import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const codexVersion = '0.158.0';
const larkVersion = '1.0.72';
const larkArchive = `lark-cli-${larkVersion}-darwin-arm64.tar.gz`;
const larkSha256 = 'b27942b83e8821934ebd34fbb02e0b00bbca949255866b5010795d625442eae2';

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('首版仅打包 macOS Apple 芯片；共用核心和桌面代码支持后续 Windows 打包。');
}

const packageInfo = JSON.parse(await readFile('node_modules/@openai/codex/package.json', 'utf8'));
const nativeInfo = JSON.parse(await readFile('node_modules/@openai/codex-darwin-arm64/package.json', 'utf8'));
if (packageInfo.version !== codexVersion || nativeInfo.version !== `${codexVersion}-darwin-arm64`) {
  throw new Error('Codex CLI 版本与固定版本不符');
}

await mkdir('build/bin', { recursive: true });
await mkdir('build/licenses', { recursive: true });
await mkdir('build/downloads', { recursive: true });

const vendor = 'node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin';
for (const [source, target] of [
  [`${vendor}/bin/codex`, 'codex'],
  [`${vendor}/bin/codex-code-mode-host`, 'codex-code-mode-host'],
  [`${vendor}/codex-path/rg`, 'rg']
]) {
  await copyFile(source, path.join('build/bin', target));
  await chmod(path.join('build/bin', target), 0o755);
}

const archivePath = path.join('build/downloads', larkArchive);
try {
  await readFile(archivePath);
} catch {
  const url = `https://github.com/larksuite/cli/releases/download/v${larkVersion}/${larkArchive}`;
  const result = spawnSync('curl', ['--fail', '--location', '--silent', '--show-error', '--output', archivePath, url], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('下载飞书 CLI 官方发布包失败');
}
const archive = await readFile(archivePath);
const digest = createHash('sha256').update(archive).digest('hex');
if (digest !== larkSha256) {
  await rm(archivePath, { force: true });
  throw new Error('飞书 CLI 官方发布包 SHA-256 校验失败');
}

const unpackDir = await mkdtemp(path.join(tmpdir(), 'feishu-codex-lark-'));
try {
  const extracted = spawnSync('tar', ['-xzf', path.resolve(archivePath), '-C', unpackDir], { stdio: 'inherit' });
  if (extracted.status !== 0) throw new Error('解压飞书 CLI 发布包失败');
  const entries = await readdir(unpackDir, { recursive: true });
  const binary = entries.find((entry) => path.basename(entry) === 'lark-cli');
  if (!binary) throw new Error('飞书 CLI 发布包缺少 lark-cli');
  await copyFile(path.join(unpackDir, binary), 'build/bin/lark-cli');
  await chmod('build/bin/lark-cli', 0o755);
} finally {
  await rm(unpackDir, { recursive: true, force: true });
}

await copyFile('resources/licenses/CODEX-APACHE-2.0.txt', 'build/licenses/CODEX-APACHE-2.0.txt');
await copyFile('resources/licenses/LARK-CLI-MIT.txt', 'build/licenses/LARK-CLI-MIT.txt');
await copyFile('node_modules/electron/LICENSE', 'build/licenses/ELECTRON-MIT.txt');
await copyFile('THIRD_PARTY_LICENSES.md', 'build/licenses/THIRD_PARTY_LICENSES.md');
await writeFile('build/bin/versions.json', `${JSON.stringify({ codex: codexVersion, larkCli: larkVersion, larkSha256 }, null, 2)}\n`);
console.log(`Prepared Codex ${codexVersion} and lark-cli ${larkVersion} for macOS arm64.`);
