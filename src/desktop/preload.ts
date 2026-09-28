import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, DesktopSnapshot, SettingsInput } from './protocol';

const api: DesktopApi = {
  getSnapshot: () => ipcRenderer.invoke('bridge:get-snapshot'),
  listModels: () => ipcRenderer.invoke('bridge:list-models'),
  saveSettings: (settings: SettingsInput) => ipcRenderer.invoke('bridge:save-settings', settings),
  start: () => ipcRenderer.invoke('bridge:start'),
  stop: () => ipcRenderer.invoke('bridge:stop'),
  windowAction: (action) => ipcRenderer.invoke('bridge:window-action', action),
  onSnapshot: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: DesktopSnapshot) => listener(snapshot);
    ipcRenderer.on('bridge:snapshot', handler);
    return () => ipcRenderer.removeListener('bridge:snapshot', handler);
  }
};

contextBridge.exposeInMainWorld('bridgeDesktop', api);
