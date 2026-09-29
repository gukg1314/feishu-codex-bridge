import type { DesktopApi, DesktopSnapshot, LogEntry, SettingsInput } from '../desktop/protocol';
import type { CodexModel } from '../core/codex';

declare global {
  interface Window { bridgeDesktop: DesktopApi }
}

const root = document.getElementById('fc-bridge-demo') as HTMLElement;
const desktop = window.bridgeDesktop;
if (navigator.platform.startsWith('Mac')) document.documentElement.classList.add('fc-native-mac');
let snapshot: DesktopSnapshot | undefined;
let busy = false;
let models: CodexModel[] = [];
let savedForm = '';
let noteTimer: ReturnType<typeof setTimeout> | undefined;

function find<T extends Element>(selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing UI element: ${selector}`);
  return element;
}

function formSignature(): string {
  const controls = find<HTMLElement>('[data-panel="settings"]')
    .querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select');
  return JSON.stringify([...controls].map((control) => control instanceof HTMLInputElement && control.type === 'checkbox'
    ? control.checked : control.value));
}

function refreshSaveState(): void {
  find<HTMLButtonElement>('[data-action="save"]').disabled = busy || !snapshot || formSignature() === savedForm;
}

function showPage(page: string): void {
  root.querySelectorAll<HTMLButtonElement>('[data-page]').forEach((button) => {
    const active = button.dataset.page === page;
    button.dataset.active = String(active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  root.querySelectorAll<HTMLElement>('[data-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.panel !== page;
  });
}

function renderLogs(container: Element, entries: LogEntry[]): void {
  container.replaceChildren();
  for (const log of entries) {
    const line = document.createElement('div');
    line.className = 'fc-log-line';
    const time = document.createElement('span');
    time.className = 'fc-log-time';
    time.textContent = log.time;
    const level = document.createElement('span');
    level.className = 'fc-log-level';
    level.dataset.level = log.level;
    level.textContent = log.level;
    const message = document.createElement('span');
    message.className = 'fc-log-message';
    message.textContent = log.message;
    line.append(time, level, message);
    container.append(line);
  }
}

function option(value: string, label: string): HTMLOptionElement {
  const element = document.createElement('option');
  element.value = value;
  element.textContent = label;
  return element;
}

function renderEfforts(preferred: string): void {
  const select = find<HTMLSelectElement>('#fc-effort');
  const model = models.find((item) => item.id === find<HTMLSelectElement>('#fc-model').value);
  const efforts = model?.reasoningEfforts ?? [];
  select.replaceChildren(...efforts.map((item) => option(item.reasoningEffort, item.reasoningEffort)));
  select.disabled = Boolean(model && !efforts.length);
  if (!model) select.add(option(preferred, preferred || '等待模型列表'));
  if (model && !efforts.length) select.add(option('', '此模型没有可选强度'));
  const available = [...select.options].map((item) => item.value);
  select.value = available.includes(preferred) ? preferred
    : available.includes(model?.defaultReasoningEffort || '') ? model?.defaultReasoningEffort || ''
      : select.options[0]?.value || '';
}

function renderModelSettings(modelId: string, effort: string): void {
  const select = find<HTMLSelectElement>('#fc-model');
  select.replaceChildren(...models.map((item) => option(item.id, item.displayName || item.id)));
  if (modelId && !models.some((item) => item.id === modelId)) {
    select.add(option(modelId, models.length ? `${modelId}（当前配置）` : modelId));
  }
  select.value = modelId || select.options[0]?.value || '';
  renderEfforts(effort);
}

async function loadModels(): Promise<void> {
  const modelId = find<HTMLSelectElement>('#fc-model').value || snapshot?.settings.model || '';
  const effort = find<HTMLSelectElement>('#fc-effort').value || snapshot?.settings.effort || '';
  const help = find<HTMLElement>('[data-model-help]');
  help.textContent = '正在读取 Codex 模型列表…';
  try {
    models = await desktop.listModels();
    renderModelSettings(modelId, effort);
    help.textContent = `已读取 ${models.length} 个模型；推理强度随模型变化。`;
  } catch (error) {
    help.textContent = error instanceof Error ? `模型读取失败：${error.message}` : '模型读取失败，请重试';
  }
  refreshSaveState();
}

function render(next: DesktopSnapshot): void {
  snapshot = next;
  const state = next.status.state;
  const running = state === 'running';
  root.dataset.running = String(running);
  find<HTMLElement>('[data-status-title]').textContent = {
    running: '桥接运行中', starting: '桥接启动中', stopping: '桥接停止中',
    stopped: '桥接已停止', error: '桥接发生错误'
  }[state];
  find<HTMLElement>('[data-status-pill]').textContent = {
    running: '运行中', starting: '启动中', stopping: '停止中',
    stopped: '已停止', error: '错误'
  }[state];
  find<HTMLElement>('[data-feishu-state]').textContent = running ? '已连接' : state === 'starting' ? '连接中' : '未连接';
  find<HTMLElement>('[data-codex-state]').textContent = running ? '已就绪' : state === 'starting' ? '启动中' : '未启动';
  find<HTMLButtonElement>('[data-action="start"]').disabled = busy || running || state === 'starting' || state === 'stopping';
  find<HTMLButtonElement>('[data-action="stop"]').disabled = busy || state === 'stopped' || state === 'stopping' || state === 'error';
  renderLogs(find('[data-recent-logs]'), next.logs.slice(0, 3));
  renderLogs(find('[data-full-logs]'), next.logs);
  refreshSaveState();
}

function populateSettings(next: DesktopSnapshot): void {
  find<HTMLInputElement>('#fc-app-id').value = next.settings.appId;
  find<HTMLInputElement>('#fc-app-secret').value = '';
  find<HTMLInputElement>('#fc-app-secret').placeholder = next.credentialsConfigured
    ? '已保存 · 输入新密钥以替换' : '输入 App Secret';
  find<HTMLTextAreaElement>('#fc-allowed-users').value = next.settings.allowedOpenIds.join('\n');
  find<HTMLTextAreaElement>('#fc-allowed-chats').value = next.settings.allowedChatIds.join('\n');
  find<HTMLInputElement>('#fc-session-timeout').value = String(next.settings.sessionTimeoutHours);
  renderModelSettings(next.settings.model, next.settings.effort);
  find<HTMLInputElement>('#fc-group-mention').checked = next.settings.allowGroupMentions;
  find<HTMLInputElement>('#fc-login-start').checked = next.settings.launchAtLogin;
  find<HTMLInputElement>('#fc-auto-connect').checked = next.settings.autoConnect;
  savedForm = formSignature();
  refreshSaveState();
}

function splitLines(value: string): string[] {
  return [...new Set(value.split(/[\s,，]+/).map((line) => line.trim()).filter(Boolean))];
}

function readSettings(): SettingsInput {
  const model = find<HTMLSelectElement>('#fc-model').value;
  const effort = find<HTMLSelectElement>('#fc-effort').value;
  if (models.length) {
    const selected = models.find((item) => item.id === model);
    if (!selected) throw new Error('当前模型不在 Codex 模型列表中，请重新选择');
    if (selected.reasoningEfforts.length && !selected.reasoningEfforts.some((item) => item.reasoningEffort === effort)) {
      throw new Error('请选择该模型支持的推理强度');
    }
  }
  return {
    appId: find<HTMLInputElement>('#fc-app-id').value.trim(),
    appSecret: find<HTMLInputElement>('#fc-app-secret').value,
    allowedOpenIds: splitLines(find<HTMLTextAreaElement>('#fc-allowed-users').value),
    allowedChatIds: splitLines(find<HTMLTextAreaElement>('#fc-allowed-chats').value),
    model,
    effort,
    sessionTimeoutHours: Number(find<HTMLInputElement>('#fc-session-timeout').value),
    allowGroupMentions: find<HTMLInputElement>('#fc-group-mention').checked,
    launchAtLogin: find<HTMLInputElement>('#fc-login-start').checked,
    autoConnect: find<HTMLInputElement>('#fc-auto-connect').checked
  };
}

function note(message: string, error = false): void {
  if (noteTimer) clearTimeout(noteTimer);
  const element = find<HTMLElement>('[data-save-note]');
  element.textContent = message;
  element.style.color = error ? 'var(--fc-red)' : 'var(--fc-green)';
  noteTimer = message && !error ? setTimeout(() => { element.textContent = ''; noteTimer = undefined; }, 2500) : undefined;
}

async function action(work: () => Promise<DesktopSnapshot>): Promise<void> {
  if (busy) return;
  busy = true;
  if (snapshot) render(snapshot);
  try {
    render(await work());
  } catch (error) {
    note(error instanceof Error ? error.message : '操作失败，请查看日志', true);
    showPage('settings');
  } finally {
    busy = false;
    if (snapshot) render(snapshot);
  }
}

for (const button of root.querySelectorAll<HTMLButtonElement>('[data-page]')) {
  button.addEventListener('click', () => showPage(button.dataset.page || 'overview'));
}
find<HTMLSelectElement>('#fc-model').addEventListener('change', () => {
  const model = models.find((item) => item.id === find<HTMLSelectElement>('#fc-model').value);
  renderEfforts(model?.defaultReasoningEffort || model?.reasoningEfforts[0]?.reasoningEffort || '');
});
for (const event of ['input', 'change']) {
  find<HTMLElement>('[data-panel="settings"]').addEventListener(event, () => {
    note('');
    refreshSaveState();
  });
}
find<HTMLButtonElement>('[data-action="refresh-models"]').addEventListener('click', () => void loadModels());
find<HTMLButtonElement>('[data-action="start"]').addEventListener('click', () => action(() => desktop.start()));
find<HTMLButtonElement>('[data-action="stop"]').addEventListener('click', () => action(() => desktop.stop()));
find<HTMLButtonElement>('[data-action="save"]').addEventListener('click', () => action(async () => {
  note('');
  const result = await desktop.saveSettings(readSettings());
  populateSettings(result);
  note('设置已保存');
  return result;
}));
for (const button of root.querySelectorAll<HTMLButtonElement>('[data-window-action]')) {
  button.addEventListener('click', () => void desktop.windowAction(button.dataset.windowAction as 'close' | 'minimize' | 'maximize'));
}
desktop.onSnapshot(render);
void desktop.getSnapshot().then((initial) => {
  populateSettings(initial);
  render(initial);
  void loadModels();
}).catch((error) => note(error instanceof Error ? error.message : '读取设置失败', true));
