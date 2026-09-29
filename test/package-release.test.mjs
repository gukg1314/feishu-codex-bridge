import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import test from 'node:test';
import { artifactNames, assertRosettaAvailable, nextPatchVersion, publishArtifacts, removeLegacyUnpackedDirs, replaceVersionFields, validateNsisInstaller } from '../scripts/package-release.mjs';

function nsisPe(ndataSize, imageSize) {
  const bytes = Buffer.alloc(512);
  bytes.write('MZ');
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write('PE\0\0', 0x80);
  bytes.writeUInt16LE(1, 0x80 + 6);
  bytes.writeUInt16LE(0xe0, 0x80 + 20);
  bytes.writeUInt16LE(0x10b, 0x80 + 24);
  bytes.writeUInt32LE(imageSize, 0x80 + 24 + 56);
  const section = 0x80 + 24 + 0xe0;
  bytes.write('.ndata', section);
  bytes.writeUInt32LE(ndataSize, section + 8);
  bytes.writeUInt32LE(0x7b000, section + 12);
  return bytes;
}

test('release uses the next patch version and expected DMG/Windows installer names', () => {
  assert.equal(nextPatchVersion('1.0.6'), '1.0.7');
  assert.equal(nextPatchVersion('1.0.7'), '1.0.8');
  assert.equal(nextPatchVersion('2.4.9'), '2.4.10');
  assert.deepEqual(artifactNames('1.0.7'), [
    '飞书桥接Codex-1.0.7-mac-arm64.dmg',
    '飞书桥接Codex-1.0.7-win-x64.exe',
  ]);
  assert.throws(() => nextPatchVersion('1.0'), /三段数字/);
});

test('Windows release uses a selectable NSIS installer', async () => {
  const packageInfo = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  const releaseScript = await readFile(resolve('scripts/package-release.mjs'), 'utf8');

  assert.deepEqual(packageInfo.build.win.target, [{ target: 'nsis', arch: ['x64'] }]);
  assert.equal(packageInfo.build.nsis.oneClick, false);
  assert.equal(packageInfo.build.nsis.allowToChangeInstallationDirectory, true);
  assert.match(releaseScript, /\['win32-x64',\s*\['--win',\s*'nsis',\s*'--x64'\]/);
});

test('release checks that Rosetta can run electron-builder makensis', () => {
  let invocation;
  assertRosettaAvailable((...args) => {
    invocation = args;
    return { status: 0 };
  });
  assert.deepEqual(invocation, ['arch', ['-x86_64', '/usr/bin/true'], { stdio: 'ignore' }]);
  assert.throws(() => assertRosettaAvailable(() => ({ status: 1 })), /Rosetta 2/);
});

test('NSIS PE validation rejects the old truncated layout and accepts a covered startup RVA', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-nsis-pe-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const badSection = join(directory, 'bad-section.exe');
  const badImage = join(directory, 'bad-image.exe');
  const good = join(directory, 'good.exe');
  await Promise.all([
    writeFile(badSection, nsisPe(0x39000, 0xb9000)),
    writeFile(badImage, nsisPe(0x1c4000, 0xb9000)),
    writeFile(good, nsisPe(0x1c4000, 0x240000)),
  ]);
  await assert.rejects(validateNsisInstaller(badSection), /必须覆盖 RVA 0xcb000/i);
  await assert.rejects(validateNsisInstaller(badImage), /必须覆盖 RVA 0xcb000/i);
  await assert.doesNotReject(validateNsisInstaller(good));
});

test('release version writes preserve JSON formatting and leave later version fields alone', () => {
  const source = '{"name":"tool","version":"1.0.6","packages":{"":{"name":"tool","version":"1.0.6"},"node_modules/other":{"version":"1.0.6"}}}\n';
  assert.equal(replaceVersionFields(source, '1.0.6', '1.0.7', 2),
    '{"name":"tool","version":"1.0.7","packages":{"":{"name":"tool","version":"1.0.7"},"node_modules/other":{"version":"1.0.6"}}}\n');
});

test('release cleanup removes only legacy unpacked macOS output folders', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-release-cleanup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all([
    mkdir(join(directory, 'mac-arm64'), { recursive: true }),
    mkdir(join(directory, '1.0.6', 'mac-arm64'), { recursive: true }),
    mkdir(join(directory, '1.0.6', 'artifacts'), { recursive: true }),
    mkdir(join(directory, 'archive', 'mac-arm64'), { recursive: true }),
  ]);

  await removeLegacyUnpackedDirs(directory);

  await assert.rejects(readdir(join(directory, 'mac-arm64')));
  await assert.rejects(readdir(join(directory, '1.0.6', 'mac-arm64')));
  assert.deepEqual(await readdir(join(directory, '1.0.6', 'artifacts')), []);
  assert.deepEqual(await readdir(join(directory, 'archive', 'mac-arm64')), []);
});

test('release publication contains only the validated DMG and EXE', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-release-publish-'));
  const staging = join(directory, 'staging');
  const release = join(directory, 'release');
  await Promise.all([mkdir(staging), mkdir(release)]);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const names = artifactNames('1.0.7');
  await Promise.all(names.map((name, index) => writeFile(join(staging, name), `artifact-${index}`)));

  const files = await publishArtifacts(staging, release, '1.0.7');

  assert.deepEqual(files.map((file) => basename(file)), names);
  assert.deepEqual((await readdir(join(release, '1.0.7'))).sort(), [...names].sort());
  assert.deepEqual(await Promise.all(files.map((file) => readFile(file, 'utf8'))), ['artifact-0', 'artifact-1']);
  assert.deepEqual(await readdir(staging), []);
});
