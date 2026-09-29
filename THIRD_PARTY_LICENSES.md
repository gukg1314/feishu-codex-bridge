# Bundled components

- Codex CLI 0.158.0, Apache-2.0: `CODEX-APACHE-2.0.txt`. Source: https://github.com/openai/codex/tree/rust-v0.158.0
- Lark CLI 1.0.72, MIT: `LARK-CLI-MIT.txt`. Source: https://github.com/larksuite/cli/releases/tag/v1.0.72
- Electron 44.4.5, MIT: `ELECTRON-MIT.txt`. Source: https://github.com/electron/electron

The bundled Codex CLI is selected from the official macOS arm64 or Windows x64 npm package for version 0.158.0. The Windows package is checked against the integrity value in `package-lock.json` when downloaded for cross packaging.

Lark CLI archives are checked against the official release SHA-256 before packaging:

- macOS arm64: `b27942b83e8821934ebd34fbb02e0b00bbca949255866b5010795d625442eae2`
- Windows x64: `e07cf77969785c98a2471e56d16f4f08c8d00045d01dc8885a51fc04217f958d`
