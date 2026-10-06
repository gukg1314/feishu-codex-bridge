import { stat } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CodexApproval, CodexModel, CodexPort, CodexProgress, CodexQuestion, CodexTurnResult } from './codex.js';
import { RouteStore } from './routes.js';
import type { BridgeLog, BridgeSettings, BridgeStatus, CardAction, CardSnapshot, IncomingMessage, LarkTransport } from './types.js';

type Prompt = { kind: 'question'; value: CodexQuestion } | { kind: 'approval'; value: CodexApproval };
type ProgressStep = { title: string; detail?: string };
type QueuedMessage = { message: IncomingMessage; settings: BridgeSettings; sessionGeneration: number };

const PROGRESS_INTERVAL_MS = 2_500;
const CONTROL_TIMEOUT_MS = 5 * 60_000;
const MODEL_PAGE_SIZE = 50;

type Command = 'session' | 'model' | 'effort' | 'cancel';

export function parseBridgeCommand(text: string): Command | undefined {
  const command = text.replace(/@_user_\d+|<at\b[^>]*>[\s\S]*?<\/at>/g, '').trim();
  const aliases: Record<string, Command> = {
    '/新建会话': 'session', '/会话': 'session',
    '/切换模型': 'model', '/切模型': 'model', '/换模型': 'model',
    '/推理强度': 'effort', '/强度': 'effort', '/推理': 'effort',
    '/取消': 'cancel',
  };
  return Object.hasOwn(aliases, command) ? aliases[command] : undefined;
}

interface ControlMenu {
  route: string;
  message: IncomingMessage;
  kind: Exclude<Command, 'cancel'>;
  cardMessageId?: string;
  snapshot: CardSnapshot;
  models: CodexModel[];
  model: string;
  page: number;
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
  executing: boolean;
  updates: Promise<void>;
}

function isChineseProgress(value: string): boolean {
  const prose = value
    .replace(/```[\s\S]*?```|`[^`]*`/g, '')
    .replace(/https?:\/\/\S+|\b[A-Za-z]:\\[^\s，。；：]+|\/[A-Za-z0-9._~+@%/-]+|\b[\w.-]+\.[A-Za-z0-9]{1,8}\b/g, '');
  const chinese = (prose.match(/[\u3400-\u9fff]/g) ?? []).length;
  const englishWords = (prose.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) ?? []).length;
  const englishNarrative = /\b(?:now|let's|the|this|that|with|each|shows?|looks?|found|reviewing|we|i)\b/i.test(prose);
  return chinese > 0 && !englishNarrative && (englishWords < 5 || chinese >= englishWords);
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
  omittedProgress: Set<string>;
  activePlan?: { key: string; title: string };
  activeOperations: Map<string, string>;
  hasCommentary: boolean;
  currentStep?: string;
  latestNarrative?: string;
  latestOperation?: string;
  reaction?: Promise<string | undefined>;
  reactionRemoval?: Promise<void>;
}

export class Bridge {
  private settings: BridgeSettings;
  private readonly store: RouteStore;
  private state: BridgeStatus['state'] = 'stopped';
  private lastError?: string;
  private queues = new Map<string, QueuedMessage[]>();
  private workers = new Set<string>();
  private active = new Map<string, ActiveMessage>();
  private cards = new Map<string, ActiveMessage>();
  private inFlightIds = new Set<string>();
  private generation = 0;
  private controls = new Map<string, ControlMenu>();
  private controlCards = new Map<string, ControlMenu>();

  constructor(private readonly options: {
    settings: BridgeSettings;
    lark: LarkTransport;
    codex: CodexPort;
    storageDir: string;
    log: BridgeLog;
    onStatus?: (status: BridgeStatus) => void;
    onSettingsChange?: (patch: { model?: string; effort?: string }, expectedModel?: string) => Promise<void>;
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
    await Promise.all([...this.controls.values()].map((menu) => this.closeControl(menu, '桥接已停止，操作已结束')));
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
    const previous = this.settings;
    const modelChanged = previous.model !== settings.model;
    this.settings = settings;
    try {
      if (modelChanged) await this.requestNewSession('模型已切换');
    } catch (error) {
      this.settings = previous;
      throw error;
    }
    await this.options.lark.updateSettings?.(settings);
    this.options.log('INFO', `Bridge model ${settings.model}, effort ${settings.effort}, idle timeout ${settings.sessionTimeoutHours}h`);
    this.report();
  }

  async requestNewSession(reason?: string): Promise<void> {
    await this.store.requestNewSession();
    this.options.log('INFO', `Next Feishu message in each route will start a new Codex session${reason ? ` (${reason})` : ''}`);
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
    const command = message.attachments.length ? undefined : parseBridgeCommand(message.text);
    if (command) {
      try {
        await this.store.markSeen(message.messageId);
        const menu = this.controls.get(route);
        if (menu?.executing) {
          await this.options.lark.sendText(message.chatId, '操作已提交，正在处理，完成后会通知。');
        } else if (command === 'cancel') {
          if (menu) {
            await this.closeControl(menu, '已取消');
            if (!menu.cardMessageId) await this.options.lark.sendText(message.chatId, '已取消。');
          } else await this.options.lark.sendText(message.chatId, '当前没有待取消的操作。');
        } else {
          await this.openControl(route, message, command);
        }
      } finally {
        this.inFlightIds.delete(message.messageId);
      }
      return;
    }
    const menu = this.controls.get(route);
    if (menu && !menu.executing) void this.closeControl(menu, '已退出菜单，继续处理消息');
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
    queue.push({ message, settings: this.settings, sessionGeneration: this.store.getSessionGeneration() });
    this.queues.set(route, queue);
    this.options.log('INFO', 'Message accepted and queued');
    this.report();
    if (!this.workers.has(route)) void this.workRoute(route, this.generation);
  }

  private async openControl(route: string, message: IncomingMessage, kind: ControlMenu['kind']): Promise<void> {
    const previous = this.controls.get(route);
    if (previous) void this.closeControl(previous, '已被新指令替换');
    if (kind === 'session' && this.workers.has(route)) {
      await this.options.lark.sendText(message.chatId, '当前聊天还有执行或排队任务，请处理完后再新建会话。');
      return;
    }
    const menu: ControlMenu = {
      route, message, kind, models: [], model: this.settings.model, page: 0,
      expiresAt: Date.now() + CONTROL_TIMEOUT_MS, executing: false, updates: Promise.resolve(),
      snapshot: {
        sessionId: message.messageId, ownerOpenId: message.senderOpenId, chatType: message.chatType,
        prompt: message.text, status: 'control', version: 1,
      },
    };
    this.controls.set(route, menu);
    menu.timer = setTimeout(() => { void this.closeControl(menu, '菜单已过期，请重新发送指令'); }, CONTROL_TIMEOUT_MS);
    menu.timer.unref?.();
    this.options.log('INFO', `Feishu control opened (${kind}, message=${message.messageId})`);
    try {
      if (kind !== 'session') menu.models = await this.options.codex.listModels();
      if (this.controls.get(route) !== menu) return;
      menu.snapshot.control = this.controlOptions(menu);
      if (kind === 'model') this.options.log('INFO', `Feishu model menu rendered (single-column, models=${menu.models.length}, pageSize=${MODEL_PAGE_SIZE})`);
      menu.cardMessageId = await this.options.lark.sendCard(message.chatId, menu.snapshot);
      if (this.controls.get(route) !== menu) {
        await this.updateControl(menu, { status: 'stopped', summary: '操作已结束', control: undefined });
        return;
      }
      this.controlCards.set(menu.cardMessageId, menu);
    } catch (error) {
      this.options.log('ERROR', `Feishu control failed to open (${kind}): ${(error as Error).message}`);
      if (this.controls.get(route) !== menu) return;
      await this.closeControl(menu, '操作未打开');
      await this.options.lark.sendText(message.chatId, (error as Error).message === '此模型没有可选推理强度'
        ? '当前模型没有可选推理强度。' : '操作打开失败，请查看运行日志后重试。');
    }
  }

  private controlOptions(menu: ControlMenu): NonNullable<CardSnapshot['control']> {
    if (menu.kind === 'session') return {
      title: '新建当前会话？', detail: '只更换当前聊天中你的 Codex 会话，原会话保留。菜单 5 分钟后失效。',
      options: [{ label: '确认新建', value: 'new_session' }],
    };
    if (menu.kind === 'effort') {
      const model = menu.models.find((item) => item.id === menu.model);
      if (!model) throw new Error('当前模型不在 Codex 模型列表中');
      if (!model.reasoningEfforts.length) throw new Error('此模型没有可选推理强度');
      return {
        title: `推理强度 · ${model.displayName}`, detail: '修改工具全局设置；之后收到的消息生效，继续原会话。菜单 5 分钟后失效。',
        options: model.reasoningEfforts.map((item) => ({
          label: `${item.reasoningEffort}${item.reasoningEffort === this.settings.effort ? '（当前）' : ''}`,
          value: item.reasoningEffort,
        })),
      };
    }
    if (!menu.models.length) throw new Error('Codex 模型列表为空');
    return {
      title: '切换模型', detail: '修改工具全局设置；换模型后，之后收到的消息新建会话。菜单 5 分钟后失效。',
      page: menu.page, pages: Math.ceil(menu.models.length / MODEL_PAGE_SIZE),
      options: menu.models.slice(menu.page * MODEL_PAGE_SIZE, (menu.page + 1) * MODEL_PAGE_SIZE).map((model) => ({
        label: `${model.displayName}${model.id === this.settings.model ? '（当前）' : ''}`, value: model.id,
      })),
    };
  }

  private updateControl(menu: ControlMenu, patch: Partial<CardSnapshot>): Promise<void> {
    menu.updates = menu.updates.then(async () => {
      if (!menu.cardMessageId) return;
      const next = { ...menu.snapshot, ...patch, version: menu.snapshot.version + 1 };
      await this.options.lark.updateCard(menu.cardMessageId, next);
      menu.snapshot = next;
    }).catch(() => this.options.log('ERROR', 'Feishu control card update failed'));
    return menu.updates;
  }

  private async closeControl(menu: ControlMenu, summary: string): Promise<void> {
    if (this.controls.get(menu.route) === menu) this.controls.delete(menu.route);
    if (menu.cardMessageId) this.controlCards.delete(menu.cardMessageId);
    if (menu.timer) clearTimeout(menu.timer);
    this.options.log('INFO', `Feishu control closed (${menu.kind}, message=${menu.message.messageId}, ${summary})`);
    await this.updateControl(menu, { status: 'stopped', summary, control: undefined });
  }

  private async onControlAction(menu: ControlMenu, action: CardAction): Promise<void> {
    const allowed = this.settings.allowedOpenIds.includes(action.actorOpenId)
      && (menu.message.chatType !== 'group' || (this.settings.allowGroupMentions && this.settings.allowedChatIds.includes(menu.message.chatId)));
    if (!allowed || menu.message.senderOpenId !== action.actorOpenId || menu.executing
      || this.controls.get(menu.route) !== menu || menu.snapshot.version !== action.version) {
      this.options.log('WARN', 'Feishu control action rejected: owner, permission or version mismatch');
      return;
    }
    if (Date.now() >= menu.expiresAt) {
      await this.closeControl(menu, '菜单已过期，请重新发送指令');
      return;
    }
    if (action.action === 'cancel') {
      await this.closeControl(menu, '已取消');
      return;
    }
    if (action.action === 'page' && menu.kind === 'model') {
      const page = Number(action.value);
      if (!Number.isSafeInteger(page) || page < 0 || page >= Math.ceil(menu.models.length / MODEL_PAGE_SIZE)) return;
      menu.page = page;
      await this.updateControl(menu, { control: this.controlOptions(menu) });
      return;
    }
    if (action.action !== 'select' || !menu.snapshot.control?.options.some((item) => item.value === action.value)) return;
    if (menu.kind === 'effort' && menu.model !== this.settings.model) {
      await this.closeControl(menu, '模型已变化，请重新发送推理强度指令');
      return;
    }
    if (menu.kind === 'session' && this.workers.has(menu.route)) {
      await this.closeControl(menu, '当前聊天还有任务，请处理完后重新发送指令');
      return;
    }
    menu.executing = true;
    const generation = this.generation;
    if (menu.timer) clearTimeout(menu.timer);
    if (menu.kind === 'session') this.workers.add(menu.route);
    this.options.log('INFO', `Feishu control submitted (${menu.kind}, message=${menu.message.messageId})`);
    await this.updateControl(menu, { control: { title: '正在处理…', detail: '操作已提交，完成后会通知。', options: [], busy: true } });
    try {
      if (this.controls.get(menu.route) !== menu) return;
      let summary: string;
      if (menu.kind === 'session') {
        const settings = this.settings;
        const sessionGeneration = this.store.getSessionGeneration();
        const threadId = await this.options.codex.startThread(settings.workingDirectory, settings.model, settings.effort);
        if (this.controls.get(menu.route) !== menu) return;
        await this.store.setThread(menu.message.chatId, menu.message.senderOpenId, threadId, sessionGeneration);
        summary = '已新建当前会话，下一条消息将进入新会话。';
        this.options.log('INFO', `Feishu route switched to a new Codex thread (chat=${menu.message.chatId}, sender=${menu.message.senderOpenId})`);
      } else {
        if (!this.options.onSettingsChange) throw new Error('远程设置保存接口未连接');
        const model = menu.models.find((item) => item.id === action.value);
        let effort = action.value!;
        if (menu.kind === 'model') {
          const efforts = model!.reasoningEfforts.map((item) => item.reasoningEffort);
          effort = efforts.includes(this.settings.effort) ? this.settings.effort
            : efforts.includes(model!.defaultReasoningEffort) ? model!.defaultReasoningEffort : efforts[0] || '';
        }
        await this.options.onSettingsChange(menu.kind === 'model' ? { model: action.value, effort } : { effort },
          menu.kind === 'effort' ? menu.model : undefined);
        summary = menu.kind === 'model'
          ? `模型已设为 ${model!.displayName}，推理强度 ${effort || '自动'}。换模型后，之后收到的消息新建会话。`
          : `推理强度已设为 ${effort}，之后收到的消息生效，继续原会话。`;
      }
      if (this.controls.get(menu.route) !== menu) return;
      await this.updateControl(menu, { status: 'completed', summary, control: undefined });
      this.options.log('INFO', `Feishu control completed (${menu.kind}, message=${menu.message.messageId})`);
    } catch (error) {
      this.options.log('ERROR', `Feishu control failed (${menu.kind}): ${(error as Error).message}`);
      if (this.controls.get(menu.route) !== menu) return;
      const detail = (error as Error).message;
      await this.updateControl(menu, { status: 'failed', summary: detail.startsWith('设置已保存') || detail.startsWith('模型已变化')
        ? detail : '操作未完成，请查看运行日志后重试。', control: undefined });
    } finally {
      if (this.controls.get(menu.route) === menu) this.controls.delete(menu.route);
      if (menu.cardMessageId) this.controlCards.delete(menu.cardMessageId);
      if (menu.kind === 'session' && generation === this.generation) {
        this.workers.delete(menu.route);
        if (this.state === 'running' && this.queues.get(menu.route)?.length) void this.workRoute(menu.route, this.generation);
      }
    }
  }

  private async workRoute(route: string, generation: number): Promise<void> {
    this.workers.add(route);
    try {
      while (generation === this.generation && this.state !== 'stopped' && this.state !== 'stopping') {
        const queued = this.queues.get(route)?.shift();
        if (!queued) break;
        const { message } = queued;
        this.report();
        try {
          await this.processMessage(route, queued, generation);
        } catch (error) {
          this.options.log('ERROR', `Message processing failed: ${(error as Error).message}`);
          const active = this.active.get(route);
          if (active && active.message.messageId === message.messageId) {
            this.markTerminal(active);
            await this.updateCard(active, { status: 'failed', summary: '执行遇到问题，请查看运行日志', question: undefined, approval: undefined });
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

  private async processMessage(route: string, queued: QueuedMessage, generation: number): Promise<void> {
    const { message, settings, sessionGeneration } = queued;
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
      terminal: false, prompts: [], lastProgressAt: 0, progressSteps: new Map(), omittedProgress: new Set(),
      activeOperations: new Map(), hasCommentary: false,
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
      const changedSession = stored && (stored.sessionGeneration ?? 0) !== sessionGeneration;
      let threadId = expired || changedSession ? undefined : stored?.threadId;
      if (expired) this.options.log('INFO', `Codex session idle for ${settings.sessionTimeoutHours} hours; creating a new thread`);
      else if (changedSession) this.options.log('INFO', 'Codex session change requested; creating a new thread');
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
        if (active.stopRequested || generation !== this.generation) return;
        await this.store.setThread(message.chatId, message.senderOpenId, threadId, sessionGeneration);
      }
      active.threadId = threadId;
      if (active.stopRequested || generation !== this.generation) return;
      const instruction = '执行过程中，对外公开的进度说明和计划请使用简体中文；代码、文件名、路径、命令和专有名词可保留原文。若生成需要回传的本地图片或文件，请在最终回复中使用指向绝对路径的 Markdown 链接。';
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
    const text = progress.text.trim();
    if (!text) return;
    if (progress.kind === 'message') {
      if (progress.phase === 'final_answer') return;
      if (!isChineseProgress(text)) {
        this.logOmittedProgress(active, progress);
        return;
      }
      if (!active.hasCommentary) this.options.log('INFO', 'Codex public commentary selected for running card');
      active.hasCommentary = true;
      active.latestNarrative = text;
      active.progressSteps.set(progress.key, { title: text });
    } else if (progress.kind === 'summary') {
      if (active.hasCommentary) return;
      if (!isChineseProgress(text)) {
        this.logOmittedProgress(active, progress);
        return;
      }
      active.latestNarrative = text;
    } else if (progress.kind === 'plan') {
      if (!isChineseProgress(text)) {
        this.logOmittedProgress(active, progress);
        return;
      }
      if (progress.status === 'inProgress') {
        active.activePlan = { key: progress.key, title: text };
        active.latestOperation = `计划：${text}`;
      } else if (active.activePlan?.key === progress.key) {
        active.activePlan = undefined;
      }
      active.progressSteps.set(progress.key, {
        title: text,
        detail: progress.status === 'completed' ? '已完成' : progress.status === 'inProgress' ? '执行中' : '待开始',
      });
    } else {
      if (progress.status === 'inProgress') active.activeOperations.set(progress.key, text);
      else active.activeOperations.delete(progress.key);
      if (!active.latestOperation) this.options.log('INFO', 'Codex operation progress selected for running card');
      active.latestOperation = progress.detail ? `${text} · ${progress.detail.trim()}` : text;
      active.progressSteps.set(progress.key, {
        title: text,
        detail: progress.detail?.trim() || undefined,
      });
    }
    active.currentStep = [...active.activeOperations.values()].at(-1) || active.activePlan?.title;
    if (!active.prompts.length) this.scheduleProgress(active);
  }

  private logOmittedProgress(active: ActiveMessage, progress: CodexProgress): void {
    const key = `${progress.kind}:${progress.key}`;
    if (active.omittedProgress.has(key) || progress.text.length < 24) return;
    active.omittedProgress.add(key);
    this.options.log('INFO', `Codex ${progress.kind} omitted from card: non-Chinese narrative`);
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
      summary: active.latestNarrative || active.latestOperation || '正在执行…',
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
    const menu = this.controlCards.get(action.cardMessageId);
    if (menu) {
      await this.onControlAction(menu, action);
      return;
    }
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
      await this.updateCard(active, { status: 'failed', summary: '执行遇到问题，请查看运行日志', question: undefined, approval: undefined });
      this.options.log('ERROR', `Codex turn failed: ${result.error || 'unknown error'}`);
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
