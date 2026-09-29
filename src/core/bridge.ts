import { stat } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CodexApproval, CodexPort, CodexProgress, CodexQuestion, CodexTurnResult } from './codex.js';
import { RouteStore } from './routes.js';
import type { BridgeLog, BridgeSettings, BridgeStatus, CardAction, CardSnapshot, IncomingMessage, LarkTransport } from './types.js';

type Prompt = { kind: 'question'; value: CodexQuestion } | { kind: 'approval'; value: CodexApproval };
type ProgressStep = { title: string; detail?: string };

const PROGRESS_INTERVAL_MS = 2_500;

function brief(value: string, limit = 220): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, limit);
}

interface ActiveMessage {
  route: string;
  message: IncomingMessage;
  cardMessageId: string;
  snapshot: CardSnapshot;
  updates: Promise<void>;
  turnId?: string;
  threadId?: string;
  stopRequested: boolean;
  terminal: boolean;
  prompts: Prompt[];
  lastProgressAt: number;
  lastProgressFingerprint?: string;
  progressTimer?: ReturnType<typeof setTimeout>;
  progressSteps: Map<string, ProgressStep>;
  currentStep?: string;
  currentStepKey?: string;
  latestPublic?: string;
  reaction?: Promise<string | undefined>;
  reactionRemoval?: Promise<void>;
}

export class Bridge {
  private settings: BridgeSettings;
  private readonly store: RouteStore;
  private state: BridgeStatus['state'] = 'stopped';
  private lastError?: string;
  private queues = new Map<string, IncomingMessage[]>();
  private workers = new Set<string>();
  private active = new Map<string, ActiveMessage>();
  private cards = new Map<string, ActiveMessage>();
  private inFlightIds = new Set<string>();
  private generation = 0;

  constructor(private readonly options: {
    settings: BridgeSettings;
    lark: LarkTransport;
    codex: CodexPort;
    storageDir: string;
    log: BridgeLog;
    onStatus?: (status: BridgeStatus) => void;
  }) {
    this.settings = options.settings;
    this.store = new RouteStore(options.storageDir);
  }

  getStatus(): BridgeStatus {
    return {
      state: this.state,
      activeTurns: this.active.size,
      queuedMessages: [...this.queues.values()].reduce((total, queue) => total + queue.length, 0),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  async start(): Promise<void> {
    if (this.state === 'running' || this.state === 'starting') return;
    this.state = 'starting';
    this.lastError = undefined;
    this.report();
    try {
      await this.store.load();
      await this.options.codex.start();
      await this.options.lark.start({
        onMessage: (message) => this.onMessage(message),
        onAction: (action) => this.onAction(action),
      });
      this.state = 'running';
      this.options.log('INFO', 'Bridge started');
      this.report();
    } catch (error) {
      await this.options.lark.stop().catch(() => undefined);
      await this.options.codex.stop().catch(() => undefined);
      this.state = 'error';
      this.lastError = (error as Error).message;
      this.options.log('ERROR', 'Bridge start failed');
      this.report();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'stopping') return;
    this.state = 'stopping';
    this.generation++;
    this.report();
    for (const active of this.active.values()) {
      active.stopRequested = true;
      this.markTerminal(active);
      if (active.threadId && active.turnId) {
        await this.options.codex.interrupt(active.threadId, active.turnId).catch(() => undefined);
      }
      await this.updateCard(active, { status: 'stopped', summary: '已停止', question: undefined, approval: undefined });
      await this.clearReaction(active);
    }
    this.queues.clear();
    const stopped = await Promise.allSettled([this.options.lark.stop(), this.options.codex.stop()]);
    this.active.clear();
    this.cards.clear();
    this.inFlightIds.clear();
    this.workers.clear();
    this.state = stopped.some((result) => result.status === 'rejected') ? 'error' : 'stopped';
    this.options.log(this.state === 'stopped' ? 'INFO' : 'ERROR', this.state === 'stopped' ? 'Bridge stopped' : 'Bridge stop failed');
    this.report();
    if (this.state === 'error') throw new Error('桥接停止失败，请查看运行日志');
  }

  async updateSettings(settings: BridgeSettings): Promise<void> {
    this.settings = settings;
    await this.options.lark.updateSettings?.(settings);
    this.options.log('INFO', `Bridge model ${settings.model}, effort ${settings.effort}, idle timeout ${settings.sessionTimeoutHours}h`);
    this.report();
  }

  private async onMessage(message: IncomingMessage): Promise<void> {
    if (this.state !== 'running' && this.state !== 'starting') return;
    if (!this.settings.allowedOpenIds.includes(message.senderOpenId)) {
      this.options.log('WARN', 'Message rejected: sender is not allowlisted');
      return;
    }
    if (message.chatType === 'group' && (!this.settings.allowGroupMentions || !this.settings.allowedChatIds.includes(message.chatId) || !message.mentionsBot)) {
      this.options.log('WARN', 'Message rejected: group policy did not match');
      return;
    }
    if (this.store.hasSeen(message.messageId) || this.inFlightIds.has(message.messageId)) return;
    this.inFlightIds.add(message.messageId);
    const route = JSON.stringify([message.chatId, message.senderOpenId]);
    const active = this.active.get(route);
    if (active?.snapshot.status === 'question' && message.replyToMessageId === active.cardMessageId && active.prompts[0]?.kind === 'question') {
      try {
        await this.store.markSeen(message.messageId);
        this.options.codex.answerQuestion(active.prompts[0].value.id, message.text);
        active.prompts.shift();
        await this.showPrompt(active);
      } finally {
        this.inFlightIds.delete(message.messageId);
      }
      return;
    }
    const queue = this.queues.get(route) ?? [];
    queue.push(message);
    this.queues.set(route, queue);
    this.options.log('INFO', 'Message accepted and queued');
    this.report();
    if (!this.workers.has(route)) void this.workRoute(route, this.generation);
  }

  private async workRoute(route: string, generation: number): Promise<void> {
    this.workers.add(route);
    try {
      while (generation === this.generation && this.state !== 'stopped' && this.state !== 'stopping') {
        const message = this.queues.get(route)?.shift();
        if (!message) break;
        this.report();
        try {
          await this.processMessage(route, message, generation);
        } catch (error) {
          this.options.log('ERROR', 'Message processing failed');
          const active = this.active.get(route);
          if (active && active.message.messageId === message.messageId) {
            this.markTerminal(active);
            await this.updateCard(active, { status: 'failed', summary: (error as Error).message, question: undefined, approval: undefined });
          }
        } finally {
          this.inFlightIds.delete(message.messageId);
          const active = this.active.get(route);
          if (active?.message.messageId === message.messageId) {
            this.active.delete(route);
            this.cards.delete(active.cardMessageId);
          }
          this.report();
        }
      }
    } finally {
      this.workers.delete(route);
      if (!this.queues.get(route)?.length) this.queues.delete(route);
      else if (this.state === 'running' && generation === this.generation) void this.workRoute(route, generation);
    }
  }

  private async processMessage(route: string, message: IncomingMessage, generation: number): Promise<void> {
    const settings = this.settings;
    const prompt = message.text || message.attachments.map((item) => item.name || item.path).join('、') || '附件';
    const snapshot: CardSnapshot = {
      sessionId: message.messageId,
      ownerOpenId: message.senderOpenId,
      chatType: message.chatType,
      prompt,
      status: 'running',
      summary: '正在执行…',
      version: 1,
    };
    const cardMessageId = await this.options.lark.sendCard(message.chatId, snapshot);
    if (generation !== this.generation) {
      await this.options.lark.updateCard(cardMessageId, { ...snapshot, status: 'stopped', summary: '已停止', version: 2 }).catch(() => undefined);
      return;
    }
    await this.store.markSeen(message.messageId);
    const active: ActiveMessage = {
      route, message, cardMessageId, snapshot, updates: Promise.resolve(), stopRequested: false,
      terminal: false, prompts: [], lastProgressAt: 0, progressSteps: new Map(),
    };
    this.active.set(route, active);
    this.cards.set(cardMessageId, active);
    this.report();
    this.options.log('INFO', 'Running card sent');
    active.reaction = this.options.lark.addReaction(message.messageId, 'GLANCE').catch(() => {
      this.options.log('WARN', 'Processing reaction add failed');
      return undefined;
    });

    try {
      const stored = this.store.getThread(message.chatId, message.senderOpenId);
      const expired = stored && Date.now() - stored.lastActiveAt >= settings.sessionTimeoutHours * 3_600_000;
      let threadId = expired ? undefined : stored?.threadId;
      if (expired) this.options.log('INFO', `Codex session idle for ${settings.sessionTimeoutHours} hours; creating a new thread`);
      if (threadId) {
        try {
          await this.options.codex.resumeThread(threadId, settings.workingDirectory, settings.model, settings.effort);
        } catch {
          this.options.log('WARN', 'Stored Codex thread could not be resumed; creating a new thread');
          threadId = undefined;
        }
      }
      if (!threadId) {
        threadId = await this.options.codex.startThread(settings.workingDirectory, settings.model, settings.effort);
        await this.store.setThread(message.chatId, message.senderOpenId, threadId);
      }
      active.threadId = threadId;
      if (active.stopRequested || generation !== this.generation) return;
      const instruction = '若生成需要回传的本地图片或文件，请在最终回复中使用指向绝对路径的 Markdown 链接。';
      const run = await this.options.codex.startTurn(threadId, `${message.text}\n\n${instruction}`.trim(), message.attachments, settings.workingDirectory, {
        onProgress: (text) => this.onProgress(active, text),
        onQuestion: (request) => this.enqueuePrompt(active, { kind: 'question', value: request }),
        onApproval: (request) => this.enqueuePrompt(active, { kind: 'approval', value: request }),
        onPromptResolved: (id) => this.resolvePrompt(active, id),
      }, settings.model, settings.effort);
      active.turnId = run.turnId;
      if (active.stopRequested || generation !== this.generation) {
        await this.options.codex.interrupt(threadId, run.turnId).catch(() => undefined);
      }
      const result = await run.completed;
      if (generation !== this.generation) return;
      await this.store.touchThread(message.chatId, message.senderOpenId, threadId);
      await this.finish(active, result);
    } finally {
      await this.clearReaction(active);
    }
  }

  private clearReaction(active: ActiveMessage): Promise<void> {
    if (!active.reactionRemoval) {
      active.reactionRemoval = (active.reaction ?? Promise.resolve(undefined)).then(async (reactionId) => {
        if (!reactionId) return;
        try {
          await this.options.lark.removeReaction(active.message.messageId, reactionId);
        } catch {
          this.options.log('WARN', 'Processing reaction removal failed');
        }
      });
    }
    return active.reactionRemoval;
  }

  private onProgress(active: ActiveMessage, progress: CodexProgress): void {
    if (active.stopRequested || active.terminal || !this.cards.has(active.cardMessageId)) return;
    const text = brief(progress.text);
    if (!text) return;
    if (progress.kind === 'summary' || progress.kind === 'message') {
      active.latestPublic = text;
      const key = active.currentStepKey && active.progressSteps.has(active.currentStepKey)
        ? active.currentStepKey : [...active.progressSteps.keys()].at(-1);
      if (key) active.progressSteps.set(key, { ...active.progressSteps.get(key)!, detail: text });
      else {
        active.currentStep = '整理进度';
        active.currentStepKey = progress.key;
        active.progressSteps.set(progress.key, { title: '公开进度摘要', detail: text });
      }
    } else if (progress.kind === 'plan') {
      if (progress.status === 'pending' && active.currentStep) return;
      if (progress.status === 'inProgress') {
        active.currentStep = text;
        active.currentStepKey = progress.key;
        if (!active.latestPublic) active.latestPublic = `计划：${text}`;
      } else if (progress.status === 'completed' && active.currentStepKey === progress.key) {
        active.currentStepKey = undefined;
      }
      active.progressSteps.delete(progress.key);
      active.progressSteps.set(progress.key, {
        title: text,
        detail: progress.status === 'completed' ? '已完成' : progress.status === 'inProgress' ? '执行中' : '待开始',
      });
    } else {
      if (!active.currentStepKey) {
        active.currentStep = text;
        active.currentStepKey = progress.status === 'inProgress' ? progress.key : undefined;
      } else if (progress.status !== 'inProgress' && active.currentStepKey === progress.key) {
        active.currentStepKey = undefined;
      }
      active.latestPublic = progress.detail ? `${text} · ${brief(progress.detail, 100)}` : text;
      active.progressSteps.delete(progress.key);
      active.progressSteps.set(progress.key, {
        title: text,
        detail: progress.detail ? brief(progress.detail, 160) : progress.status === 'failed' ? '失败' : progress.status === 'completed' ? '已完成' : '执行中',
      });
    }
    while (active.progressSteps.size > 3) active.progressSteps.delete(active.progressSteps.keys().next().value!);
    if (!active.prompts.length) this.scheduleProgress(active);
  }

  private scheduleProgress(active: ActiveMessage): void {
    if (active.progressTimer || active.terminal) return;
    const wait = Math.max(100, PROGRESS_INTERVAL_MS - (Date.now() - active.lastProgressAt));
    active.progressTimer = setTimeout(() => {
      active.progressTimer = undefined;
      this.flushProgress(active);
    }, wait);
  }

  private progressPatch(active: ActiveMessage): Partial<CardSnapshot> {
    return {
      status: 'running',
      currentStep: active.currentStep,
      summary: active.latestPublic || '正在执行…',
      steps: [...active.progressSteps.values()],
    };
  }

  private flushProgress(active: ActiveMessage): void {
    if (active.stopRequested || active.terminal || active.prompts.length || !this.cards.has(active.cardMessageId)) return;
    const patch = this.progressPatch(active);
    const fingerprint = JSON.stringify(patch);
    if (fingerprint === active.lastProgressFingerprint) return;
    active.lastProgressFingerprint = fingerprint;
    active.lastProgressAt = Date.now();
    void this.updateCard(active, patch);
    this.options.log('INFO', 'Running card progress queued');
  }

  private clearProgressTimer(active: ActiveMessage): void {
    if (active.progressTimer) clearTimeout(active.progressTimer);
    active.progressTimer = undefined;
  }

  private markTerminal(active: ActiveMessage): void {
    active.terminal = true;
    this.clearProgressTimer(active);
  }

  private enqueuePrompt(active: ActiveMessage, prompt: Prompt): void {
    active.prompts.push(prompt);
    if (active.prompts.length === 1) void this.showPrompt(active);
  }

  private resolvePrompt(active: ActiveMessage, id: number | string): void {
    const index = active.prompts.findIndex((prompt) => prompt.value.id === id);
    if (index < 0) return;
    active.prompts.splice(index, 1);
    if (index === 0) void this.showPrompt(active);
  }

  private async showPrompt(active: ActiveMessage): Promise<void> {
    if (active.stopRequested || active.terminal || !this.cards.has(active.cardMessageId)) return;
    this.clearProgressTimer(active);
    const prompt = active.prompts[0];
    if (!prompt) {
      await this.updateCard(active, { ...this.progressPatch(active), question: undefined, approval: undefined });
    } else if (prompt.kind === 'question') {
      await this.updateCard(active, { status: 'question', summary: '等待回答', question: { text: prompt.value.text, options: prompt.value.options }, approval: undefined });
      this.options.log('INFO', 'Running card switched to question');
    } else {
      await this.updateCard(active, { status: 'approval', summary: '等待审批', approval: { title: prompt.value.title, detail: prompt.value.detail }, question: undefined });
      this.options.log('INFO', 'Running card switched to approval');
    }
  }

  private async onAction(action: CardAction): Promise<void> {
    const active = this.cards.get(action.cardMessageId);
    const oldRunningStop = action.action === 'stop' && active?.snapshot.status === 'running'
      && typeof action.version === 'number' && action.version >= 1 && action.version <= active.snapshot.version;
    if (!active || active.stopRequested || active.terminal || active.message.senderOpenId !== action.actorOpenId
      || (!oldRunningStop && active.snapshot.version !== action.version)) {
      this.options.log('WARN', 'Card action rejected: owner or version mismatch');
      return;
    }
    if (action.action === 'stop' && active.snapshot.status !== 'running') return;
    if (action.action === 'stop' || (action.action === 'deny' && active.prompts[0]?.kind === 'question')) {
      active.stopRequested = true;
      this.markTerminal(active);
      this.options.log('INFO', 'Turn stop requested from card');
      await this.updateCard(active, { status: 'stopped', summary: '已停止', question: undefined, approval: undefined });
      void this.clearReaction(active);
      if (active.threadId && active.turnId) await this.options.codex.interrupt(active.threadId, active.turnId).catch(() => undefined);
      return;
    }
    const prompt = active.prompts[0];
    if (!prompt) return;
    if (action.action === 'answer' && prompt.kind === 'question') {
      this.options.codex.answerQuestion(prompt.value.id, action.value ?? '');
    } else if ((action.action === 'approve' || action.action === 'deny') && prompt.kind === 'approval') {
      this.options.codex.answerApproval(prompt.value.id, action.action === 'approve');
    } else {
      return;
    }
    active.prompts.shift();
    this.options.log('INFO', 'Card response forwarded to Codex');
    await this.showPrompt(active);
  }

  private async finish(active: ActiveMessage, result: CodexTurnResult): Promise<void> {
    active.prompts.length = 0;
    this.markTerminal(active);
    if (active.stopRequested || result.status === 'interrupted') {
      await this.updateCard(active, { status: 'stopped', summary: '已停止', question: undefined, approval: undefined });
    } else if (result.status === 'failed') {
      await this.updateCard(active, { status: 'failed', summary: result.error || '执行失败', question: undefined, approval: undefined });
      this.options.log('ERROR', 'Codex turn failed');
    } else {
      await this.updateCard(active, { status: 'completed', summary: result.text || '已完成', steps: [], details: [], question: undefined, approval: undefined });
      await this.sendOutputFiles(active.message.chatId, result.text);
      this.options.log('INFO', 'Codex turn completed');
    }
  }

  private updateCard(active: ActiveMessage, patch: Partial<CardSnapshot>): Promise<void> {
    active.updates = active.updates.then(async () => {
      if (this.cards.get(active.cardMessageId) !== active) return;
      if (active.terminal && (patch.status === 'running' || patch.status === 'question' || patch.status === 'approval')) return;
      const next = { ...active.snapshot, ...patch, version: active.snapshot.version + 1 };
      if (JSON.stringify({ ...next, version: 0 }) === JSON.stringify({ ...active.snapshot, version: 0 })) return;
      await this.options.lark.updateCard(active.cardMessageId, next);
      active.snapshot = next;
      this.options.log('INFO', `Card updated (${next.status}, version=${next.version})`);
    }).catch(() => {
      this.options.log('ERROR', 'Card update failed');
    });
    return active.updates;
  }

  private async sendOutputFiles(chatId: string, text: string): Promise<void> {
    const links = /!?\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\)/g;
    const sent = new Set<string>();
    for (const match of text.matchAll(links)) {
      let path = match[1].replace(/^<|>$/g, '');
      try {
        path = path.startsWith('file://') ? fileURLToPath(path) : decodeURIComponent(path);
        if (!isAbsolute(path) || sent.has(path) || !(await stat(path)).isFile()) continue;
        sent.add(path);
        const isImage = /\.(png|jpe?g|gif|webp|bmp)$/i.test(extname(path));
        if (isImage) await this.options.lark.sendImage(chatId, path);
        else await this.options.lark.sendFile(chatId, path);
      } catch {
        this.options.log('WARN', 'Output attachment could not be sent');
      }
    }
  }

  private report(): void {
    this.options.onStatus?.(this.getStatus());
  }
}
