import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { artifactNames, nextPatchVersion, publishArtifacts, removeLegacyUnpackedDirs, replaceVersionFields } from '../scripts/package-release.mjs';

test('release uses the next patch version and the expected DMG/portable EXE names', () => {
  assert.equal(nextPatchVersion('1.0.6'), '1.0.7');
  assert.equal(nextPatchVersion('2.4.9'), '2.4.10');
  assert.deepEqual(artifactNames('1.0.7'), [
    '飞书桥接Codex-1.0.7-mac-arm64.dmg',
    '飞书桥接Codex-1.0.7-win-x64.exe',
  ]);
  assert.throws(() => nextPatchVersion('1.0'), /三段数字/);
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
