import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const codexVersion = '0.158.0';
const larkVersion = '1.0.72';
const targets = {
  'darwin-arm64': {
    vendor: 'aarch64-apple-darwin',
    extension: '',
    larkArchive: `lark-cli-${larkVersion}-darwin-arm64.tar.gz`,
    larkSha256: 'b27942b83e8821934ebd34fbb02e0b00bbca949255866b5010795d625442eae2'
  },
  'win32-x64': {
    vendor: 'x86_64-pc-windows-msvc',
    extension: '.exe',
    larkArchive: `lark-cli-${larkVersion}-windows-amd64.zip`,
    larkSha256: 'e07cf77969785c98a2471e56d16f4f08c8d00045d01dc8885a51fc04217f958d'
  }
};

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} 执行失败：${result.error?.message ?? `退出码 ${result.status}`}`);
  }
}

async function verifiedArchive(filename, url, algorithm, expected) {
  const downloads = path.join(root, 'build/downloads');
  await mkdir(downloads, { recursive: true });
  const archivePath = path.join(downloads, filename);
  let archive;
  try {
    archive = await readFile(archivePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (archive && createHash(algorithm).update(archive).digest(algorithm === 'sha512' ? 'base64' : 'hex') !== expected) {
    await rm(archivePath);
    archive = undefined;
  }
  if (!archive) {
    console.log(`[二进制] 下载 ${filename}`);
    run('curl', ['--fail', '--location', '--silent', '--show-error', '--output', archivePath, url]);
    archive = await readFile(archivePath);
    if (createHash(algorithm).update(archive).digest(algorithm === 'sha512' ? 'base64' : 'hex') !== expected) {
      await rm(archivePath, { force: true });
      throw new Error(`${filename} 校验失败`);
    }
  }
  return archivePath;
}

async function codexPackageRoot(target, temporaryDir) {
  const packageDir = path.join(root, 'node_modules/@openai', `codex-${target}`);
  try {
    const info = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
    if (info.version !== `${codexVersion}-${target}`) {
      throw new Error(`Codex ${target} 版本与 ${codexVersion} 不符`);
    }
    return packageDir;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const entry = lock.packages[`node_modules/@openai/codex-${target}`];
  if (entry?.version !== `${codexVersion}-${target}` || !entry.resolved || !entry.integrity?.startsWith('sha512-')) {
    throw new Error(`package-lock.json 缺少固定的 Codex ${target} 发布包`);
  }
  const archive = await verifiedArchive(`codex-${entry.version}.tgz`, entry.resolved, 'sha512', entry.integrity.slice(7));
  run('tar', ['-xzf', archive, '-C', temporaryDir]);
  return path.join(temporaryDir, 'package');
}

export async function prepareBinaries(target = `${process.platform}-${process.arch}`) {
  const settings = targets[target];
  if (!settings) throw new Error(`不支持的二进制目标：${target}`);
  const codexInfo = JSON.parse(await readFile(path.join(root, 'node_modules/@openai/codex/package.json'), 'utf8'));
  if (codexInfo.version !== codexVersion) throw new Error(`Codex CLI 必须为 ${codexVersion}`);

  const binDir = path.join(root, 'build/bin');
  const licensesDir = path.join(root, 'build/licenses');
  await rm(binDir, { recursive: true, force: true });
  await rm(licensesDir, { recursive: true, force: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(licensesDir, { recursive: true });
  const temporaryDir = await mkdtemp(path.join(tmpdir(), 'feishu-codex-binaries-'));
  try {
    const nativeRoot = await codexPackageRoot(target, temporaryDir);
    const vendor = path.join(nativeRoot, 'vendor', settings.vendor);
    for (const name of ['codex', 'codex-code-mode-host', 'rg']) {
      const filename = `${name}${settings.extension}`;
      const source = path.join(vendor, name === 'rg' ? 'codex-path' : 'bin', filename);
      const destination = path.join(binDir, filename);
      await copyFile(source, destination);
      if (!settings.extension) await chmod(destination, 0o755);
    }

    const archive = await verifiedArchive(
      settings.larkArchive,
      `https://github.com/larksuite/cli/releases/download/v${larkVersion}/${settings.larkArchive}`,
      'sha256',
      settings.larkSha256
    );
    const larkDir = path.join(temporaryDir, 'lark');
    await mkdir(larkDir);
    run('tar', ['-xf', archive, '-C', larkDir]);
    const larkFilename = `lark-cli${settings.extension}`;
    const entries = await readdir(larkDir, { recursive: true });
    const binary = entries.find((entry) => path.basename(entry) === larkFilename);
    if (!binary) throw new Error(`${settings.larkArchive} 缺少 ${larkFilename}`);
    const larkDestination = path.join(binDir, larkFilename);
    await copyFile(path.join(larkDir, binary), larkDestination);
    if (!settings.extension) await chmod(larkDestination, 0o755);

    await copyFile(path.join(root, 'resources/licenses/CODEX-APACHE-2.0.txt'), path.join(licensesDir, 'CODEX-APACHE-2.0.txt'));
    await copyFile(path.join(root, 'resources/licenses/LARK-CLI-MIT.txt'), path.join(licensesDir, 'LARK-CLI-MIT.txt'));
    await copyFile(path.join(root, 'node_modules/electron/LICENSE'), path.join(licensesDir, 'ELECTRON-MIT.txt'));
    await copyFile(path.join(root, 'THIRD_PARTY_LICENSES.md'), path.join(licensesDir, 'THIRD_PARTY_LICENSES.md'));
    await writeFile(path.join(binDir, 'versions.json'), `${JSON.stringify({ target, codex: codexVersion, larkCli: larkVersion, larkSha256: settings.larkSha256 }, null, 2)}\n`);
    console.log(`[二进制] 已准备 ${target}：Codex ${codexVersion}、lark-cli ${larkVersion}`);
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareBinaries(process.argv[2]).catch((error) => {
    console.error(`[二进制] ${error.message}`);
    process.exitCode = 1;
  });
}
