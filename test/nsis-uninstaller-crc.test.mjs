import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { NSIS_PATH, NsisTargetOptions, UninstallerReader } = require('app-builder-lib/out/targets/nsis/nsisUtil.js');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 512; index < buffer.length - 4; index += 1) {
    crc ^= buffer[index];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

test('NSIS Reader reconstructs an uninstaller with a valid CRC', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-nsis-crc-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scriptPath = join(directory, 'installer.nsi');
  const installerPath = join(directory, 'installer.exe');
  const uninstallerPath = join(directory, 'uninstaller.exe');

  await writeFile(scriptPath, String.raw`Unicode true
Name "NSIS CRC regression"
OutFile "installer.exe"
InstallDir "$TEMP\NsisCrcRegression"
RequestExecutionLevel user
CRCCheck on
SilentInstall silent
SilentUnInstall silent

Section "Install"
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\uninstaller.exe"
SectionEnd

Section "Uninstall"
SectionEnd
`);

  delete process.env.ELECTRON_BUILDER_NSIS_DIR;
  NsisTargetOptions.resolve({});
  const nsisPath = await NSIS_PATH();
  const makensis = join(nsisPath, process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'Bin' : 'linux', process.platform === 'win32' ? 'makensis.exe' : 'makensis');
  const compile = spawnSync(makensis, ['-WX', '-INPUTCHARSET', 'UTF8', scriptPath], {
    cwd: directory,
    env: { ...process.env, NSISDIR: nsisPath },
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.ifError(compile.error);
  assert.equal(compile.status, 0, `makensis failed:\n${compile.stdout}\n${compile.stderr}`);

  await UninstallerReader.exec(installerPath, uninstallerPath);
  const uninstaller = await readFile(uninstallerPath);
  assert.ok(uninstaller.length > 516, 'reconstructed uninstaller is too short for an NSIS CRC');
  assert.equal(uninstaller.readUInt32LE(uninstaller.length - 4), crc32(uninstaller));

  if (process.platform === 'win32') {
    const run = spawnSync(uninstallerPath, ['/S'], {
      cwd: directory,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.ifError(run.error);
    assert.equal(run.status, 0, `reconstructed uninstaller failed:\n${run.stdout}\n${run.stderr}`);
  }

  const damaged = Buffer.from(uninstaller);
  damaged[512] ^= 1;
  await writeFile(uninstallerPath, damaged);
  await assert.rejects(UninstallerReader.verify(uninstallerPath), /CRC mismatch/);

  const noCrc = Buffer.from(uninstaller);
  const flagsOffset = noCrc.indexOf('NullsoftInst') - 8;
  assert.ok(flagsOffset >= 512, 'NSIS header was not found');
  noCrc.writeUInt32LE(noCrc.readUInt32LE(flagsOffset) | 4, flagsOffset);
  await writeFile(uninstallerPath, noCrc);
  await assert.rejects(UninstallerReader.verify(uninstallerPath), /CRC disabled/);
});
