import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const releaseRoot = path.join(root, 'release');
const product = '飞书桥接Codex';
const nsisStartupRva = 0xCB000;

export function nextPatchVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`版本号不是三段数字：${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

export function replaceVersionFields(source, previous, next, count) {
  let replaced = 0;
  const result = source.replace(/("version"\s*:\s*")([^"]+)(")/g, (full, before, value, after) => {
    if (value !== previous || replaced === count) return full;
    replaced += 1;
    return `${before}${next}${after}`;
  });
  if (replaced !== count) throw new Error('版本字段数量与预期不符');
  return result;
}

export async function removeLegacyUnpackedDirs(directory) {
  await rm(path.join(directory, 'mac-arm64'), { recursive: true, force: true });
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name)) {
      await rm(path.join(directory, entry.name, 'mac-arm64'), { recursive: true, force: true });
    }
  }
}

export function artifactNames(version) {
  return [
    `${product}-${version}-mac-arm64.dmg`,
    `${product}-${version}-win-x64.exe`
  ];
}

export async function publishArtifacts(stagingOutput, directory, version) {
  const names = artifactNames(version);
  const destination = path.join(directory, version);
  for (const name of names) {
    const file = await stat(path.join(stagingOutput, name));
    if (!file.isFile() || file.size === 0) throw new Error(`打包产物无效：${name}`);
  }
  await mkdir(destination);
  try {
    for (const name of names) await rename(path.join(stagingOutput, name), path.join(destination, name));
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
  return names.map((name) => path.join(destination, name));
}

function runNode(script, args = [], env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, script), ...args], { cwd: root, stdio: 'inherit', env });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} 失败（${signal ?? `退出码 ${code}`}）`));
    });
  });
}

export function assertRosettaAvailable(run = spawnSync) {
  const check = run('arch', ['-x86_64', '/usr/bin/true'], { stdio: 'ignore' });
  if (check.status !== 0) {
    throw new Error('Windows EXE 需要 Rosetta 2 才能运行 electron-builder 内置的 makensis；请先运行 softwareupdate --install-rosetta --agree-to-license。');
  }
}

export async function validateNsisInstaller(file) {
  const handle = await open(file, 'r');
  let header;
  try {
    const bytes = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    header = bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }

  if (header.length < 64 || header.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error('Windows NSIS 安装包 PE 头无效');
  }
  const peOffset = header.readUInt32LE(0x3c);
  if (peOffset + 24 > header.length || header.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error('Windows NSIS 安装包 PE 头无效');
  }
  const sectionCount = header.readUInt16LE(peOffset + 6);
  const optionalSize = header.readUInt16LE(peOffset + 20);
  const optionalOffset = peOffset + 24;
  const sectionOffset = optionalOffset + optionalSize;
  if (optionalSize < 60 || sectionOffset + sectionCount * 40 > header.length) {
    throw new Error('Windows NSIS 安装包 PE 头无效');
  }
  const imageSize = header.readUInt32LE(optionalOffset + 56);
  let ndataStart = -1;
  let ndataEnd = -1;
  for (let i = 0; i < sectionCount; i += 1) {
    const offset = sectionOffset + i * 40;
    if (header.toString('ascii', offset, offset + 8).replace(/\0+$/, '') !== '.ndata') continue;
    ndataStart = header.readUInt32LE(offset + 12);
    ndataEnd = ndataStart + header.readUInt32LE(offset + 8);
    break;
  }
  if (ndataStart > nsisStartupRva || ndataEnd <= nsisStartupRva || imageSize <= nsisStartupRva) {
    throw new Error(`Windows NSIS 安装包 PE 校验失败：.ndata 结束于 0x${ndataEnd.toString(16)}，SizeOfImage=0x${imageSize.toString(16)}，必须覆盖 RVA 0x${nsisStartupRva.toString(16)}`);
  }
}

export async function packageRelease() {
  if (process.platform !== 'darwin') throw new Error('同时生成 DMG 和 Windows EXE 需要在 macOS 上运行。');
  const packagePath = path.join(root, 'package.json');
  const lockPath = path.join(root, 'package-lock.json');
  const [originalPackage, originalLock] = await Promise.all([readFile(packagePath, 'utf8'), readFile(lockPath, 'utf8')]);
  const packageInfo = JSON.parse(originalPackage);
  const lockInfo = JSON.parse(originalLock);
  if (packageInfo.version !== lockInfo.version || lockInfo.packages[''].version !== packageInfo.version) {
    throw new Error('package.json 与 package-lock.json 版本不一致');
  }
  assertRosettaAvailable();
  const version = nextPatchVersion(packageInfo.version);
  await mkdir(releaseRoot, { recursive: true });
  await removeLegacyUnpackedDirs(releaseRoot);
  const staging = await mkdtemp(path.join(releaseRoot, '.staging-'));
  const output = path.join(staging, 'ready');
  let published = false;
  let versionWriteStarted = false;
  try {
    console.log(`[打包] 准备 ${version}，先生成 Mac DMG 与 Windows EXE`);
    const windowsEnvironment = { ...process.env };
    delete windowsEnvironment.ELECTRON_BUILDER_NSIS_DIR;
    await runNode('scripts/build.mjs');
    await mkdir(output);
    for (const [target, builderArgs, artifact] of [
      ['darwin-arm64', ['--mac', 'dmg', '--arm64'], artifactNames(version)[0]],
      ['win32-x64', ['--win', 'nsis', '--x64'], artifactNames(version)[1]]
    ]) {
      console.log(`[打包] 构建 ${target}`);
      await runNode('scripts/prepare-binaries.mjs', [target]);
      const builderOutput = path.join(staging, target);
      await runNode('node_modules/electron-builder/cli.js', [
        ...builderArgs,
        '--publish', 'never',
        `--config.extraMetadata.version=${version}`,
        `--config.directories.output=${builderOutput}`
      ], target === 'win32-x64' ? windowsEnvironment : process.env);
      if (target === 'win32-x64') {
        await validateNsisInstaller(path.join(builderOutput, artifact));
        console.log('[打包] Windows EXE PE 校验通过：.ndata 与 SizeOfImage 覆盖 NSIS 启动 RVA');
      }
      await rename(path.join(builderOutput, artifact), path.join(output, artifact));
    }
    const files = await publishArtifacts(output, releaseRoot, version);
    published = true;
    const nextPackage = replaceVersionFields(originalPackage, packageInfo.version, version, 1);
    const nextLock = replaceVersionFields(originalLock, packageInfo.version, version, 2);
    versionWriteStarted = true;
    await writeFile(packagePath, nextPackage);
    await writeFile(lockPath, nextLock);
    console.log(`[打包] ${version} 完成：`);
    for (const file of files) console.log(file);
    return files;
  } catch (error) {
    console.error(`[打包] ${version} 失败，版本保持不变：${error.message}`);
    if (versionWriteStarted) await Promise.all([writeFile(packagePath, originalPackage), writeFile(lockPath, originalLock)]);
    if (published) await rm(path.join(releaseRoot, version), { recursive: true, force: true });
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packageRelease().catch(() => { process.exitCode = 1; });
}
