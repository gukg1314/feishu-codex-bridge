import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { BridgeSettings } from '../core/types';
import type { SettingsInput } from './protocol';

export type SavedSettings = { settings: BridgeSettings; credentialsConfigured: boolean };

export function defaultSettings(): SavedSettings {
  return {
    settings: {
      appId: '',
      allowedOpenIds: [],
      allowedChatIds: [],
      workingDirectory: homedir(),
      model: 'gpt-6-sol',
      effort: 'max',
      sessionTimeoutHours: 24,
      allowGroupMentions: false,
      launchAtLogin: false,
      autoConnect: false
    },
    credentialsConfigured: false
  };
}

export async function loadSettings(filePath: string): Promise<SavedSettings> {
  try {
    const saved = JSON.parse(await readFile(filePath, 'utf8')) as SavedSettings;
    const defaults = defaultSettings();
    return {
      settings: {
        ...defaults.settings,
        ...saved.settings,
        allowedOpenIds: Array.isArray(saved.settings?.allowedOpenIds) ? saved.settings.allowedOpenIds : [],
        allowedChatIds: Array.isArray(saved.settings?.allowedChatIds) ? saved.settings.allowedChatIds : []
      },
      credentialsConfigured: saved.credentialsConfigured === true
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultSettings();
    throw new Error('设置文件读取失败，请检查应用数据目录');
  }
}

export async function validateSettings(input: SettingsInput): Promise<BridgeSettings> {
  if (!input || typeof input !== 'object') throw new Error('设置格式无效');
  if (typeof input.appId !== 'string' || !/^cli_[A-Za-z0-9]+$/.test(input.appId.trim())) {
    throw new Error('请填写有效的飞书 App ID');
  }
  if (typeof input.appSecret !== 'string') throw new Error('App Secret 格式无效');
  if (!Array.isArray(input.allowedOpenIds) || input.allowedOpenIds.some((id) => typeof id !== 'string' || !/^ou_[A-Za-z0-9_-]+$/.test(id))) {
    throw new Error('成员 open_id 必须每行一个，格式为 ou_...');
  }
  if (!Array.isArray(input.allowedChatIds) || input.allowedChatIds.some((id) => typeof id !== 'string' || !/^oc_[A-Za-z0-9_-]+$/.test(id))) {
    throw new Error('群聊会话 ID 必须每行一个，格式为 oc_...');
  }
  if (typeof input.workingDirectory !== 'string' || !input.workingDirectory.trim()) {
    throw new Error('请选择工作目录');
  }
  if (typeof input.model !== 'string' || !input.model.trim()) throw new Error('请选择 Codex 模型');
  if (typeof input.effort !== 'string') throw new Error('模型推理强度格式无效');
  if (!Number.isSafeInteger(input.sessionTimeoutHours) || input.sessionTimeoutHours < 1) {
    throw new Error('会话超时必须是至少 1 小时的整数');
  }
  const workingDirectory = path.resolve(input.workingDirectory.trim());
  try {
    if (!(await stat(workingDirectory)).isDirectory()) throw new Error('工作目录不是文件夹');
  } catch (error) {
    if (error instanceof Error && error.message === '工作目录不是文件夹') throw error;
    throw new Error('工作目录不存在或无法访问');
  }
  for (const key of ['allowGroupMentions', 'launchAtLogin', 'autoConnect'] as const) {
    if (typeof input[key] !== 'boolean') throw new Error('开关设置格式无效');
  }
  return {
    appId: input.appId.trim(),
    allowedOpenIds: [...new Set(input.allowedOpenIds)],
    allowedChatIds: [...new Set(input.allowedChatIds)],
    workingDirectory,
    model: input.model.trim(),
    effort: input.effort.trim(),
    sessionTimeoutHours: input.sessionTimeoutHours,
    allowGroupMentions: input.allowGroupMentions,
    launchAtLogin: input.launchAtLogin,
    autoConnect: input.autoConnect
  };
}

export async function saveSettings(filePath: string, saved: SavedSettings): Promise<void> {
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, filePath);
}
