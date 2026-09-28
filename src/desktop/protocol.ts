import type { BridgeSettings, BridgeStatus } from '../core/types';
import type { CodexModel } from '../core/codex';

export type LogEntry = {
  time: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  message: string;
};

export type DesktopSnapshot = {
  settings: BridgeSettings;
  credentialsConfigured: boolean;
  status: BridgeStatus;
  logs: LogEntry[];
};

export type SettingsInput = Omit<BridgeSettings, 'workingDirectory'> & { appSecret: string };

export type DesktopApi = {
  getSnapshot(): Promise<DesktopSnapshot>;
  listModels(): Promise<CodexModel[]>;
  saveSettings(settings: SettingsInput): Promise<DesktopSnapshot>;
  start(): Promise<DesktopSnapshot>;
  stop(): Promise<DesktopSnapshot>;
  windowAction(action: 'close' | 'minimize' | 'maximize'): Promise<void>;
  onSnapshot(listener: (snapshot: DesktopSnapshot) => void): () => void;
};
