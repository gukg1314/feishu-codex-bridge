import type { DesktopApi, DesktopSnapshot, LogEntry, SettingsInput } from '../desktop/protocol';
import type { CodexModel } from '../core/codex';

declare global {
  interface Window { bridgeDesktop: DesktopApi }
}

const root = document.getElementById('fc-bridge-demo') as HTMLElement;
const desktop = window.bridgeDesktop;
if (navigator.platform.startsWith('Mac')) document.documentElement.classList.add('fc-native-mac');
if (navigator.platform.startsWith('Win')) document.documentElement.classList.add('fc-native-win');
let snapshot: DesktopSnapshot | undefined;
let busy = false;
let busyAction = '';
let modelsLoading = false;
let logFilter = 'all';
let models: CodexModel[] = [];
let savedForm = '';
let noteTimer: ReturnType<typeof setTimeout> | undefined;
let lastShownError: string | undefined;

function find<T extends Element>(selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing UI element: ${selector}`);
  return element;
}

find<HTMLElement>('[data-dock-setting]').hidden = !navigator.platform.startsWith('Mac');

function formSignature(): string {
  const controls = find<HTMLElement>('[data-panel="settings"]')
    .querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select');
  return JSON.stringify(Object.fromEntries([...controls].map((control) => [control.id,
    control instanceof HTMLInputElement && control.type === 'checkbox' ? control.checked : control.value])));
}

function refreshSaveState(): void {
  const dirty = Boolean(snapshot && formSignature() !== savedForm);
  find<HTMLButtonElement>('[data-action="save"]').disabled = busy || !snapshot || !dirty;
  find<HTMLElement>('[data-dirty-note]').textContent = dirty ? '未保存' : '';
}

function refreshSettingsControls(): void {
  find<HTMLElement>('#fc-group-fields').hidden = !find<HTMLInputElement>('#fc-group-mention').checked;
  find<HTMLInputElement>('#fc-app-secret').required = Boolean(snapshot && (!snapshot.credentialsConfigured ||
    find<HTMLInputElement>('#fc-app-id').value.trim() !== snapshot.settings.appId));
}

function showPage(page: string): void {
  root.querySelectorAll<HTMLElement>(':popover-open').forEach((popover) => popover.hidePopover());
  root.querySelectorAll<HTMLButtonElement>('[data-page]').forEach((button) => {
    const active = button.dataset.page === page;
    button.dataset.active = String(active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  root.querySelectorAll<HTMLElement>('[data-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.panel !== page;
  });
  find<HTMLElement>('.fc-main').scrollTop = 0;
  const heading = find<HTMLElement>(`[data-panel="${page}"] h1`);
  heading.setAttribute('tabindex', '-1');
  heading.focus({ preventScroll: true });
}

function renderLogs(container: Element, entries: LogEntry[]): void {
  container.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'fc-empty';
    empty.textContent = '暂无日志';
    container.append(empty);
    return;
  }
  for (const log of entries) {
    const line = document.createElement('div');
    line.className = 'fc-log-line';
    const time = document.createElement('span');
    time.className = 'fc-log-time';
    time.textContent = log.time;
    const level = document.createElement('span');
    level.className = 'fc-log-level';
    level.dataset.level = log.level;
    level.textContent = { INFO: 'i', WARN: '!', ERROR: '×' }[log.level];
    level.title = { INFO: '信息', WARN: '警告', ERROR: '错误' }[log.level];
    level.setAttribute('role', 'img');
    level.setAttribute('aria-label', level.title);
    const message = document.createElement('span');
    message.className = 'fc-log-message';
    message.textContent = log.message;
    line.append(time, level, message);
    container.append(line);
  }
}

function renderFullLogs(): void {
  renderLogs(find('[data-full-logs]'), (snapshot?.logs ?? []).filter((entry) => logFilter === 'all' || entry.level === logFilter));
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
  if (modelsLoading) return;
  modelsLoading = true;
  const help = find<HTMLElement>('[data-model-help]');
  const button = find<HTMLButtonElement>('[data-action="refresh-models"]');
  button.disabled = true;
  button.textContent = '读取中…';
  help.textContent = '';
  help.style.color = '';
  try {
    models = await desktop.listModels();
    const modelId = find<HTMLSelectElement>('#fc-model').value || snapshot?.settings.model || '';
    const effort = find<HTMLSelectElement>('#fc-effort').value || snapshot?.settings.effort || '';
    renderModelSettings(modelId, effort);
    if (snapshot) find<HTMLElement>('[data-current-model]').textContent = models.find((item) => item.id === snapshot?.settings.model)?.displayName || snapshot.settings.model;
  } catch (error) {
    help.textContent = error instanceof Error ? `模型读取失败：${error.message}` : '模型读取失败，请重试';
    help.style.color = 'var(--fc-red)';
  } finally {
    modelsLoading = false;
    button.disabled = false;
    button.textContent = '刷新模型列表';
    refreshSaveState();
  }
}

function render(next: DesktopSnapshot): void {
  if (snapshot && savedForm && (snapshot.settings.model !== next.settings.model || snapshot.settings.effort !== next.settings.effort)) {
    renderModelSettings(next.settings.model, next.settings.effort);
    const baseline = JSON.parse(savedForm) as Record<string, string | boolean>;
    baseline['fc-model'] = next.settings.model;
    baseline['fc-effort'] = next.settings.effort;
    savedForm = JSON.stringify(baseline);
  }
  snapshot = next;
  find<HTMLElement>('.fc-version').textContent = `v${next.version}`;
  const state = next.status.state;
  const running = state === 'running';
  const ready = Boolean(next.settings.appId && next.credentialsConfigured && next.settings.allowedOpenIds.length);
  root.dataset.running = String(running);
  root.dataset.state = state;
  find<HTMLElement>('[data-status-title]').textContent = {
    running: '运行中', starting: '启动中', stopping: '停止中',
    stopped: ready ? '已停止' : '待配置', error: '发生错误'
  }[state];
  find<HTMLElement>('[data-active-turns]').textContent = String(next.status.activeTurns);
  find<HTMLElement>('[data-queued-messages]').textContent = String(next.status.queuedMessages);
  find<HTMLElement>('[data-current-model]').textContent = models.find((item) => item.id === next.settings.model)?.displayName || next.settings.model;
  find<HTMLElement>('[data-current-effort]').textContent = next.settings.effort || '自动';
  find<HTMLButtonElement>('[data-action="setup"]').hidden = ready;
  find<HTMLButtonElement>('[data-action="start"]').disabled = busy || !ready || running || state === 'starting' || state === 'stopping';
  find<HTMLButtonElement>('[data-action="stop"]').disabled = busy || state === 'stopped' || state === 'stopping' || state === 'error';
  find<HTMLButtonElement>('[data-action="new-session"]').disabled = busy || state === 'starting' || state === 'stopping';
  for (const [name, idle, pending] of [
    ['start', '启动桥接', '启动中…'], ['stop', '停止桥接', '停止中…'],
    ['save', '保存设置', '保存中…'], ['new-session', '新建会话', '安排中…']
  ]) find<HTMLButtonElement>(`[data-action="${name}"]`).textContent = busyAction === name ? pending : idle;
  // 保存可能需要重连，暂时锁定输入，避免完成时覆盖等待期间的新编辑。
  find<HTMLFieldSetElement>('[data-settings-fields]').disabled = busyAction === 'save';
  renderLogs(find('[data-recent-logs]'), next.logs.slice(0, 3));
  renderFullLogs();
  refreshSettingsControls();
  refreshSaveState();
  if (next.status.lastError && next.status.lastError !== lastShownError) note(next.status.lastError, true);
  lastShownError = next.status.lastError;
}

function populateSettings(next: DesktopSnapshot): void {
  find<HTMLInputElement>('#fc-app-id').value = next.settings.appId;
  find<HTMLInputElement>('#fc-app-secret').value = '';
  find<HTMLInputElement>('#fc-app-secret').placeholder = next.credentialsConfigured
    ? '留空保留已保存的密钥' : '输入 App Secret';
  find<HTMLTextAreaElement>('#fc-allowed-users').value = next.settings.allowedOpenIds.join('\n');
  find<HTMLTextAreaElement>('#fc-allowed-chats').value = next.settings.allowedChatIds.join('\n');
  find<HTMLInputElement>('#fc-session-timeout').value = String(next.settings.sessionTimeoutHours);
  renderModelSettings(next.settings.model, next.settings.effort);
  find<HTMLInputElement>('#fc-group-mention').checked = next.settings.allowGroupMentions;
  find<HTMLInputElement>('#fc-login-start').checked = next.settings.launchAtLogin;
  find<HTMLInputElement>('#fc-auto-connect').checked = next.settings.autoConnect;
  find<HTMLInputElement>('#fc-hide-dock').checked = next.settings.hideDockIcon;
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
    autoConnect: find<HTMLInputElement>('#fc-auto-connect').checked,
    hideDockIcon: find<HTMLInputElement>('#fc-hide-dock').checked
  };
}

function note(message: string, error = false): void {
  if (noteTimer) clearTimeout(noteTimer);
  const element = find<HTMLElement>('[data-save-note]');
  element.textContent = error ? '' : message;
  element.style.color = error ? 'var(--fc-red)' : 'var(--fc-green)';
  find<HTMLElement>('[data-ui-notice]').hidden = !error || !message;
  find<HTMLElement>('[data-ui-message]').textContent = error ? message : '';
  noteTimer = message && !error ? setTimeout(() => { element.textContent = ''; noteTimer = undefined; }, 2500) : undefined;
}

async function action(work: () => Promise<DesktopSnapshot>, name: string): Promise<void> {
  if (busy) return;
  busy = true;
  busyAction = name;
  note('');
  if (snapshot) render(snapshot);
  try {
    render(await work());
  } catch (error) {
    note(error instanceof Error ? error.message : '操作失败，请查看日志', true);
    if (name === 'save') {
      const message = error instanceof Error ? error.message : '';
      const fields: [string, string][] = [['App Secret', 'app-secret'], ['App ID', 'app-id'], ['成员', 'allowed-users'],
        ['群聊', 'allowed-chats'], ['推理强度', 'effort'], ['模型', 'model'], ['会话超时', 'session-timeout']];
      const field = fields.find(([label]) => message.includes(label));
      if (field) {
        const control = find<HTMLInputElement>(`#fc-${field[1]}`);
        control.setAttribute('aria-invalid', 'true');
        queueMicrotask(() => control.focus());
      }
    }
  } finally {
    busy = false;
    busyAction = '';
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
  find<HTMLElement>('[data-panel="settings"]').addEventListener(event, (change) => {
    note('');
    if (change.target instanceof HTMLElement) change.target.removeAttribute('aria-invalid');
    refreshSettingsControls();
    refreshSaveState();
  });
}
find<HTMLButtonElement>('[data-action="refresh-models"]').addEventListener('click', () => void loadModels());
find<HTMLButtonElement>('[data-action="start"]').addEventListener('click', () => action(() => desktop.start(), 'start'));
find<HTMLButtonElement>('[data-action="stop"]').addEventListener('click', () => action(() => desktop.stop(), 'stop'));
find<HTMLButtonElement>('[data-action="new-session"]').addEventListener('click', () => {
  if (busy) return;
  void (async () => {
    busy = true;
    busyAction = 'new-session';
    note('');
    if (snapshot) render(snapshot);
    const feedback = find<HTMLElement>('[data-session-note]');
    feedback.textContent = '';
    try {
      render(await desktop.newSession());
      feedback.textContent = '已安排新会话，之后新收到的指令生效。';
      feedback.style.color = '';
    } catch (error) {
      feedback.textContent = error instanceof Error ? `新建会话失败：${error.message}` : '新建会话失败，请查看日志';
      feedback.style.color = 'var(--fc-red)';
    } finally {
      busy = false;
      busyAction = '';
      if (snapshot) render(snapshot);
    }
  })();
});
find<HTMLFormElement>('#fc-settings-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void action(async () => {
    const result = await desktop.saveSettings(readSettings());
    populateSettings(result);
    note('设置已保存');
    return result;
  }, 'save');
});
for (const button of root.querySelectorAll<HTMLButtonElement>('[data-action="view-logs"]')) {
  button.addEventListener('click', () => showPage('logs'));
}
find<HTMLButtonElement>('[data-action="setup"]').addEventListener('click', () => showPage('settings'));
find<HTMLButtonElement>('[data-action="dismiss-notice"]').addEventListener('click', () => note(''));
for (const button of root.querySelectorAll<HTMLButtonElement>('[data-log-filter]')) {
  button.addEventListener('click', () => {
    logFilter = button.dataset.logFilter || 'all';
    root.querySelectorAll<HTMLButtonElement>('[data-log-filter]').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
    renderFullLogs();
  });
}
document.addEventListener('keydown', (event) => {
  if (!event.metaKey && !event.ctrlKey) return;
  if (event.key === ',') { event.preventDefault(); showPage('settings'); }
  if (event.key.toLowerCase() === 's' && !find<HTMLElement>('[data-panel="settings"]').hidden) {
    event.preventDefault();
    if (!find<HTMLButtonElement>('[data-action="save"]').disabled) find<HTMLFormElement>('#fc-settings-form').requestSubmit();
  }
});
desktop.onSnapshot(render);
void desktop.getSnapshot().then((initial) => {
  populateSettings(initial);
  render(initial);
  void loadModels();
}).catch((error) => note(error instanceof Error ? error.message : '读取设置失败', true));
