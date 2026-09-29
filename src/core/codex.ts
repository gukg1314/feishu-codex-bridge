import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import packageJson from '../../package.json';
import type { BridgeLog, IncomingAttachment } from './types.js';

type RequestId = number | string;
type JsonObject = Record<string, unknown>;

export interface CodexQuestion {
  id: RequestId;
  text: string;
  options?: string[];
}

export interface CodexApproval {
  id: RequestId;
  title: string;
  detail?: string;
}

export interface CodexTurnEvents {
  onProgress: (progress: CodexProgress) => void;
  onQuestion: (request: CodexQuestion) => void;
  onApproval: (request: CodexApproval) => void;
  onPromptResolved?: (id: RequestId) => void;
}

export interface CodexProgress {
  kind: 'summary' | 'message' | 'plan' | 'operation';
  key: string;
  text: string;
  detail?: string;
  phase?: 'commentary' | 'final_answer';
  status?: 'pending' | 'inProgress' | 'completed' | 'failed';
}

export interface CodexTurnResult {
  status: 'completed' | 'interrupted' | 'failed';
  text: string;
  error?: string;
}

export interface CodexRun {
  turnId: string;
  completed: Promise<CodexTurnResult>;
}

export interface CodexModel {
  id: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  defaultReasoningEffort: string;
  reasoningEfforts: { reasoningEffort: string; description: string }[];
}

export interface CodexPort {
  start(): Promise<void>;
  stop(): Promise<void>;
  listModels(): Promise<CodexModel[]>;
  startThread(cwd: string, model: string, effort: string): Promise<string>;
  resumeThread(threadId: string, cwd: string, model: string, effort: string): Promise<void>;
  startTurn(threadId: string, text: string, attachments: IncomingAttachment[], cwd: string, events: CodexTurnEvents, model: string, effort: string): Promise<CodexRun>;
  interrupt(threadId: string, turnId: string): Promise<void>;
  answerQuestion(id: RequestId, answer: string): void;
  answerApproval(id: RequestId, approved: boolean): void;
}

interface PendingCall {
  resolve: (value: JsonObject) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingServerRequest {
  method: string;
  params: JsonObject;
}

interface RunningTurn {
  threadId: string;
  turnId?: string;
  events: CodexTurnEvents;
  messages: Map<string, { text: string; phase?: string }>;
  summaries: Map<string, Map<number, string>>;
  progress: Map<string, string>;
  pendingNotifications: { method: string; params: JsonObject }[];
  resolve: (result: CodexTurnResult) => void;
  completed: Promise<CodexTurnResult>;
}

export class CodexClient implements CodexPort {
  private process?: ChildProcessWithoutNullStreams;
  private lines?: Interface;
  private nextId = 1;
  private pending = new Map<RequestId, PendingCall>();
  private serverRequests = new Map<RequestId, PendingServerRequest>();
  private turns = new Map<string, RunningTurn>();

  constructor(private readonly options: { binaryPath: string; log: BridgeLog; version?: string }) {}

  async start(): Promise<void> {
    if (this.process) return;
    const child = spawn(this.options.binaryPath, ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
      windowsHide: true,
    });
    this.process = child;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', (line) => this.receive(line));
    child.stderr.on('data', () => {
      // stderr can contain user content or credentials; keep only a diagnostic marker.
      this.options.log('WARN', 'Codex app-server wrote diagnostic output');
    });
    child.once('error', (error) => this.disconnected(error));
    child.once('exit', (code) => this.disconnected(new Error(`Codex app-server exited (${code ?? 'unknown'})`)));

    try {
      await this.request('initialize', {
        clientInfo: { name: 'feishu_codex_bridge', title: '飞书桥接Codex', version: this.options.version ?? packageJson.version },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      this.send({ method: 'initialized', params: {} });
      const account = await this.request('account/read', { refreshToken: false });
      if (!account.account) throw new Error('当前 Codex 未登录，请先在 Codex 中登录');
      this.options.log('INFO', 'Codex app-server connected');
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const child = this.process;
    this.process = undefined;
    this.lines?.close();
    this.lines = undefined;
    this.disconnected(new Error('Codex app-server stopped'));
    if (child) {
      child.stdin.end();
      child.kill();
    }
  }

  async listModels(): Promise<CodexModel[]> {
    const models: CodexModel[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.request('model/list', { includeHidden: true, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(response.data)) throw new Error('Codex did not return a model list');
      for (const item of response.data as JsonObject[]) {
        const id = item.model;
        if (typeof id !== 'string') continue;
        const efforts = Array.isArray(item.supportedReasoningEfforts)
          ? item.supportedReasoningEfforts as JsonObject[] : [];
        models.push({
          id,
          displayName: typeof item.displayName === 'string' ? item.displayName : id,
          description: typeof item.description === 'string' ? item.description : '',
          hidden: item.hidden === true,
          isDefault: item.isDefault === true,
          defaultReasoningEffort: typeof item.defaultReasoningEffort === 'string' ? item.defaultReasoningEffort : '',
          reasoningEfforts: efforts.flatMap((option) => typeof option.reasoningEffort === 'string'
            ? [{ reasoningEffort: option.reasoningEffort, description: typeof option.description === 'string' ? option.description : '' }]
            : []),
        });
      }
      cursor = typeof response.nextCursor === 'string' ? response.nextCursor : undefined;
    } while (cursor);
    this.options.log('INFO', `Codex model catalog loaded (${models.length} models)`);
    return models;
  }

  async startThread(cwd: string, model: string, effort: string): Promise<string> {
    const response = await this.request('thread/start', {
      cwd,
      model,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      serviceName: 'feishu_codex_bridge',
    });
    const id = (response.thread as JsonObject | undefined)?.id;
    if (typeof id !== 'string') throw new Error('Codex did not return a thread ID');
    this.options.log('INFO', `Codex thread started (model=${model}, effort=${effort || 'default'}, approval=never, sandbox=danger-full-access)`);
    return id;
  }

  async resumeThread(threadId: string, cwd: string, model: string, effort: string): Promise<void> {
    await this.request('thread/resume', {
      threadId,
      cwd,
      model,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      excludeTurns: true,
    });
    this.options.log('INFO', `Codex thread resumed (model=${model}, effort=${effort || 'default'}, approval=never, sandbox=danger-full-access)`);
  }

  async startTurn(threadId: string, text: string, attachments: IncomingAttachment[], cwd: string, events: CodexTurnEvents, model: string, effort: string): Promise<CodexRun> {
    if (this.turns.has(threadId)) throw new Error('A Codex turn is already running for this route');
    const paths = attachments.filter((item) => item.kind === 'file').map((item) => item.path);
    const prompt = paths.length ? `${text}\n\n附件文件（可按需读取）：\n${paths.join('\n')}` : text;
    const input: JsonObject[] = [{ type: 'text', text: prompt || '请查看附件。', text_elements: [] }];
    for (const attachment of attachments) {
      if (attachment.kind === 'image') input.push({ type: 'localImage', path: attachment.path });
    }
    let resolve!: (result: CodexTurnResult) => void;
    const completed = new Promise<CodexTurnResult>((done) => { resolve = done; });
    const running: RunningTurn = {
      threadId, events, messages: new Map(), summaries: new Map(), progress: new Map(),
      pendingNotifications: [], resolve, completed,
    };
    this.turns.set(threadId, running);
    try {
      const response = await this.request('turn/start', {
        threadId, cwd, input, model, ...(effort ? { effort } : {}),
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
        summary: 'auto',
      });
      const turnId = (response.turn as JsonObject | undefined)?.id;
      if (typeof turnId !== 'string') throw new Error('Codex did not return a turn ID');
      running.turnId = turnId;
      for (const notification of running.pendingNotifications) {
        this.receiveNotification(notification.method, notification.params);
      }
      running.pendingNotifications.length = 0;
      this.options.log('INFO', `Codex turn started (model=${model}, effort=${effort || 'default'}, approval=never, sandbox=danger-full-access)`);
      return { turnId, completed };
    } catch (error) {
      this.turns.delete(threadId);
      resolve({ status: 'failed', text: '', error: (error as Error).message });
      throw error;
    }
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.request('turn/interrupt', { threadId, turnId });
  }

  answerQuestion(id: RequestId, answer: string): void {
    const pending = this.serverRequests.get(id);
    if (!pending || pending.method !== 'item/tool/requestUserInput') return;
    this.serverRequests.delete(id);
    const questions = Array.isArray(pending.params.questions) ? pending.params.questions as JsonObject[] : [];
    const lines = questions.length > 1 ? answer.split(/\r?\n/) : [answer];
    const answers: JsonObject = {};
    questions.forEach((question, index) => {
      if (typeof question.id === 'string') answers[question.id] = { answers: [lines[index]?.trim() ?? ''] };
    });
    this.send({ id, result: { answers } });
  }

  answerApproval(id: RequestId, approved: boolean): void {
    const pending = this.serverRequests.get(id);
    if (!pending || !pending.method.includes('Approval')) return;
    this.serverRequests.delete(id);
    let result: JsonObject;
    if (pending.method === 'item/permissions/requestApproval') {
      const requested = pending.params.permissions as JsonObject | undefined;
      result = { permissions: approved ? Object.fromEntries(Object.entries(requested ?? {}).filter(([, value]) => value != null)) : {}, scope: 'turn' };
    } else if (pending.method === 'applyPatchApproval' || pending.method === 'execCommandApproval') {
      result = { decision: approved ? 'approved' : { denied: { rejection: '用户在飞书中拒绝' } } };
    } else {
      result = { decision: approved ? 'accept' : 'decline' };
    }
    this.send({ id, result });
  }

  private request(method: string, params: JsonObject): Promise<JsonObject> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private send(message: JsonObject): void {
    if (!this.process?.stdin.writable) throw new Error('Codex app-server is not connected');
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      this.options.log('WARN', 'Codex app-server sent invalid JSON');
      return;
    }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id as RequestId);
      if (!pending) return;
      this.pending.delete(message.id as RequestId);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = message.error as JsonObject;
        pending.reject(new Error(String(error.message ?? 'Codex request failed')));
      } else {
        pending.resolve((message.result ?? {}) as JsonObject);
      }
      return;
    }
    if (typeof message.method !== 'string') return;
    if (message.id !== undefined) this.receiveServerRequest(message.id as RequestId, message.method, (message.params ?? {}) as JsonObject);
    else this.receiveNotification(message.method, (message.params ?? {}) as JsonObject);
  }

  private receiveServerRequest(id: RequestId, method: string, params: JsonObject): void {
    const running = this.turns.get(String(params.threadId ?? params.conversationId ?? ''));
    if (!running || (running.turnId && params.turnId && params.turnId !== running.turnId)) {
      this.send({ id, error: { code: -32602, message: 'No active Feishu turn' } });
      return;
    }
    if (method === 'item/tool/requestUserInput') {
      const questions = Array.isArray(params.questions) ? params.questions as JsonObject[] : [];
      const text = questions.map((question, index) => `${index + 1}. ${String(question.header ?? '')} ${String(question.question ?? '')}`.trim()).join('\n');
      const options = questions.length === 1 && Array.isArray(questions[0].options)
        ? (questions[0].options as JsonObject[]).map((option) => String(option.label ?? ''))
        : undefined;
      this.serverRequests.set(id, { method, params });
      running.events.onQuestion({ id, text: questions.length > 1 ? `${text}\n请按行依次回答。` : text, options });
      return;
    }
    if (method.includes('Approval')) {
      const title = method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval' ? '修改文件需要批准' : method === 'item/permissions/requestApproval' ? '请求额外权限' : '执行操作需要批准';
      const network = params.networkApprovalContext as JsonObject | undefined;
      const detail = [
        params.reason,
        params.command,
        params.grantRoot,
        network ? `网络：${String(network.host ?? '')} ${String(network.protocol ?? '')}` : undefined,
        params.permissions ? `权限：${JSON.stringify(params.permissions)}` : undefined,
      ].filter((value) => typeof value === 'string' && value).join('\n');
      this.serverRequests.set(id, { method, params });
      running.events.onApproval({ id, title, detail: detail || undefined });
      return;
    }
    this.send({ id, error: { code: -32601, message: 'Unsupported server request' } });
  }

  private receiveNotification(method: string, params: JsonObject): void {
    if (method === 'serverRequest/resolved') {
      const id = params.requestId as RequestId;
      const running = this.turns.get(String(params.threadId ?? ''));
      if (running && (!params.turnId || params.turnId === running.turnId)) {
        this.serverRequests.delete(id);
        running.events.onPromptResolved?.(id);
      }
      return;
    }
    const running = this.turns.get(String(params.threadId ?? ''));
    if (!running) return;
    const incomingTurnId = typeof params.turnId === 'string' ? params.turnId : (params.turn as JsonObject | undefined)?.id;
    if (!running.turnId) {
      running.pendingNotifications.push({ method, params });
      return;
    }
    if (incomingTurnId !== running.turnId) return;
    if (method === 'item/agentMessage/delta') {
      const itemId = String(params.itemId ?? '');
      const item: { text: string; phase?: string } = running.messages.get(itemId) ?? { text: '' };
      item.text += String(params.delta ?? '');
      running.messages.set(itemId, item);
      this.emitProgress(running, { kind: 'message', key: `message:${itemId}`, text: item.text,
        phase: item.phase === 'commentary' || item.phase === 'final_answer' ? item.phase : undefined });
    } else if (method === 'item/reasoning/summaryPartAdded') {
      const itemId = String(params.itemId ?? '');
      const index = params.summaryIndex;
      if (itemId && Number.isSafeInteger(index) && !running.summaries.get(itemId)?.has(index as number)) {
        const parts = running.summaries.get(itemId) ?? new Map<number, string>();
        parts.set(index as number, '');
        running.summaries.set(itemId, parts);
      }
    } else if (method === 'item/reasoning/summaryTextDelta') {
      const itemId = String(params.itemId ?? '');
      const index = params.summaryIndex;
      if (!itemId || !Number.isSafeInteger(index) || typeof params.delta !== 'string') return;
      const parts = running.summaries.get(itemId) ?? new Map<number, string>();
      const text = (parts.get(index as number) ?? '') + params.delta;
      parts.set(index as number, text);
      running.summaries.set(itemId, parts);
      this.emitProgress(running, { kind: 'summary', key: `reasoning:${itemId}:${index}`, text });
    } else if (method === 'turn/plan/updated') {
      const plan = Array.isArray(params.plan) ? params.plan as JsonObject[] : [];
      plan.forEach((step, index) => {
        if (typeof step.step !== 'string') return;
        const status = step.status === 'pending' || step.status === 'inProgress' || step.status === 'completed' ? step.status : undefined;
        this.emitProgress(running, { kind: 'plan', key: `plan:${index}`, text: step.step, status });
      });
    } else if (method === 'item/started') {
      const item = params.item as JsonObject | undefined;
      if (item?.type === 'agentMessage' && typeof item.id === 'string') {
        running.messages.set(item.id, {
          text: typeof item.text === 'string' ? item.text : '',
          phase: typeof item.phase === 'string' ? item.phase : undefined,
        });
      } else {
        this.emitOperation(running, item, 'inProgress');
      }
    } else if (method === 'item/completed') {
      const item = params.item as JsonObject | undefined;
      if (item?.type === 'agentMessage' && typeof item.id === 'string') {
        const previous = running.messages.get(item.id);
        const text = typeof item.text === 'string' ? item.text : previous?.text ?? '';
        const phase = typeof item.phase === 'string' ? item.phase : previous?.phase;
        running.messages.set(item.id, { text, phase });
        this.emitProgress(running, { kind: 'message', key: `message:${item.id}`, text,
          phase: phase === 'commentary' || phase === 'final_answer' ? phase : undefined });
      } else if (item?.type === 'reasoning' && typeof item.id === 'string' && Array.isArray(item.summary)) {
        const parts = running.summaries.get(item.id) ?? new Map<number, string>();
        (item.summary as unknown[]).forEach((value, index) => {
          if (typeof value !== 'string') return;
          parts.set(index, value);
          this.emitProgress(running, { kind: 'summary', key: `reasoning:${item.id}:${index}`, text: value });
        });
        running.summaries.set(item.id, parts);
      } else {
        this.emitOperation(running, item, 'completed');
      }
    } else if (method === 'turn/completed') {
      const turn = params.turn as JsonObject | undefined;
      const status = turn?.status === 'interrupted' ? 'interrupted' : turn?.status === 'failed' ? 'failed' : 'completed';
      const messages = [...running.messages.values()];
      const finals = messages.filter((item) => item.phase === 'final_answer');
      const text = (finals.length ? finals : messages.slice(-1)).map((item) => item.text).join('\n\n');
      const error = (turn?.error as JsonObject | undefined)?.message;
      for (const [id, request] of this.serverRequests) {
        if (request.params.threadId === running.threadId) this.serverRequests.delete(id);
      }
      this.turns.delete(running.threadId);
      running.resolve({ status, text, error: typeof error === 'string' ? error : undefined });
    }
  }

  private emitProgress(running: RunningTurn, progress: CodexProgress): void {
    if (!progress.text.trim()) return;
    const signature = `${progress.text}\u0000${progress.detail ?? ''}\u0000${progress.status ?? ''}\u0000${progress.phase ?? ''}`;
    if (running.progress.get(progress.key) === signature) return;
    running.progress.set(progress.key, signature);
    running.events.onProgress(progress);
  }

  private emitOperation(running: RunningTurn, item: JsonObject | undefined, phase: 'inProgress' | 'completed'): void {
    if (!item || typeof item.id !== 'string') return;
    const failed = item.status === 'failed' || item.status === 'declined';
    const status = failed ? 'failed' : phase;
    let text: string;
    let detail: string | undefined;
    if (item.type === 'commandExecution') {
      const actions = Array.isArray(item.commandActions) ? item.commandActions as JsonObject[] : [];
      const action = actions.find((value) => value.type === 'read' || value.type === 'listFiles' || value.type === 'search');
      if (action?.type === 'read') text = phase === 'inProgress' ? '正在读取文件' : failed ? '读取文件遇到问题' : '已读取文件';
      else if (action?.type === 'listFiles') text = phase === 'inProgress' ? '正在查看文件列表' : failed ? '查看文件列表遇到问题' : '已查看文件列表';
      else if (action?.type === 'search') text = phase === 'inProgress' ? '正在搜索文件' : failed ? item.exitCode === 1 ? '搜索未找到结果' : '搜索文件遇到问题' : '已搜索文件';
      else text = phase === 'inProgress' ? '正在运行命令' : failed ? '命令运行遇到问题' : '已运行命令';
      if (phase === 'completed' && failed) {
        this.options.log('WARN', `Codex command finished with status=${String(item.status ?? 'unknown')}, exitCode=${typeof item.exitCode === 'number' ? item.exitCode : 'unknown'}`);
      }
    } else if (item.type === 'fileChange') {
      const changes = Array.isArray(item.changes) ? item.changes as JsonObject[] : [];
      text = phase === 'inProgress' ? '正在修改文件' : failed ? '文件修改未完成' : '已修改文件';
      detail = changes.map((change) => typeof change.path === 'string' ? change.path.split(/[\\/]/).pop() : undefined)
        .filter(Boolean).slice(0, 3).join('、') || undefined;
    } else if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
      const tool = typeof item.tool === 'string' ? item.tool : typeof item.name === 'string' ? item.name : '工具';
      text = phase === 'inProgress' ? '正在使用工具' : failed ? '工具调用未完成' : '已使用工具';
      detail = tool;
    } else if (item.type === 'imageView') {
      text = phase === 'inProgress' ? '正在查看图像' : '已查看图像';
    } else if (item.type === 'webSearch') {
      text = phase === 'inProgress' ? '正在搜索网页' : '已搜索网页';
    } else if (item.type === 'imageGeneration') {
      text = phase === 'inProgress' ? '正在生成图像' : '已生成图像';
    } else {
      return;
    }
    this.emitProgress(running, { kind: 'operation', key: `operation:${item.id}`, text, detail, status });
  }

  private disconnected(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    this.serverRequests.clear();
    for (const running of this.turns.values()) running.resolve({ status: 'failed', text: '', error: error.message });
    this.turns.clear();
    this.process = undefined;
  }
}
