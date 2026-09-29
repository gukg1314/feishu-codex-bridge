import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";

import { hydrateLarkMessage, normalizeLarkInboundEvent } from "./attachments.js";
import { buildLarkCard, type CardSnapshot } from "./card.js";
import { runLarkCli, runLarkCliWithData, sendLarkMedia, sendLarkText, type LarkCommand } from "./media.js";
import type { BridgeSettings, CardAction, IncomingMessage, LarkTransport } from "./types.js";

type Handler = {
  onMessage: (message: IncomingMessage) => Promise<void> | void;
  onAction: (action: CardAction) => Promise<void> | void;
};

type Consumer = {
  child?: ChildProcessWithoutNullStreams;
  reconnect?: ReturnType<typeof setTimeout>;
};

type CardState = {
  chatId: string;
  ownerOpenId: string;
  sessionId: string;
  snapshot: CardSnapshot;
};

type LarkOptions = LarkCommand & {
  settings: BridgeSettings;
  workDir: string;
  log: (level: "info" | "warn" | "error", message: string) => void;
};

const MESSAGE_EVENT = "im.message.receive_v1";
const ACTION_EVENT = "card.action.trigger";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function findField(value: unknown, field: string): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findField(item, field);
      if (found) return found;
    }
    return undefined;
  }
  const item = record(value);
  if (!item) return undefined;
  const direct = string(item[field]);
  if (direct) return direct;
  for (const nested of Object.values(item)) {
    const found = findField(nested, field);
    if (found) return found;
  }
  return undefined;
}

export function normalizeLarkCardAction(value: unknown): {
  eventId: string;
  cardMessageId: string;
  chatId: string;
  actorOpenId: string;
  callbackToken: string;
  sessionId: string;
  action: CardAction["action"];
  value?: string;
  version: number;
} | null {
  const event = record(value);
  if (!event || event.type !== ACTION_EVENT || event.action_tag !== "button") return null;
  const eventId = string(event.event_id);
  const cardMessageId = string(event.message_id);
  const chatId = string(event.chat_id);
  const actorOpenId = string(event.operator_id);
  const callbackToken = string(event.token);
  let payload: unknown = event.action_value;
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload); } catch { return null; }
  }
  const actionValue = record(payload);
  const sessionId = string(actionValue?.sessionId);
  const version = actionValue?.cardVersion;
  if (!eventId || !cardMessageId || !chatId || !actorOpenId || !callbackToken || !sessionId || actionValue?.v !== 1
    || !Number.isSafeInteger(version) || Number(version) < 1) return null;
  const actionMap: Record<string, CardAction["action"]> = {
    stop_session: "stop",
    question_answer: "answer",
    permission_allow: "approve",
    permission_deny: "deny",
  };
  const action = actionMap[string(actionValue.action) ?? ""];
  if (!action) return null;
  const answer = string(actionValue.answer);
  if (action === "answer" && !answer) return null;
  return {
    eventId,
    cardMessageId,
    chatId,
    actorOpenId,
    callbackToken,
    sessionId,
    action,
    ...(answer ? { value: answer } : {}),
    version: Number(version),
  };
}

export class LarkCliTransport implements LarkTransport {
  private settings: BridgeSettings;
  private readonly command: LarkCommand;
  private readonly workDir: string;
  private readonly log: LarkOptions["log"];
  private readonly consumers = new Map<string, Consumer>();
  private readonly cards = new Map<string, CardState>();
  private readonly seenMessageIds = new Set<string>();
  private readonly seenActionIds = new Set<string>();
  private readonly usedCardVersions = new Set<string>();
  private handlers?: Handler;
  private botOpenId?: string;
  private running = false;

  constructor(options: LarkOptions) {
    this.settings = options.settings;
    this.command = { cliPath: options.cliPath, profile: options.profile };
    this.workDir = options.workDir;
    this.log = options.log;
  }

  updateSettings(settings: BridgeSettings): void {
    this.settings = settings;
  }

  async start(handlers: Handler): Promise<void> {
    if (this.running) return;
    this.handlers = handlers;
    await mkdir(this.workDir, { recursive: true });
    const status = JSON.parse(await runLarkCli(this.command, ["auth", "status", "--verify", "--json"])) as unknown;
    const currentAppId = string(record(status)?.appId);
    if (currentAppId && currentAppId !== this.settings.appId) {
      throw new Error("飞书桥接 profile 的 App ID 与桌面设置不一致");
    }
    const identities = record(record(status)?.identities);
    this.botOpenId = string(record(identities?.bot)?.openId);
    if (!this.botOpenId) this.log("warn", "飞书机器人 open_id 不可用，群聊消息将被忽略");
    this.running = true;
    try {
      await Promise.all([this.startConsumer(MESSAGE_EVENT), this.startConsumer(ACTION_EVENT)]);
      this.log("info", "飞书消息与卡片回调监听已连接");
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    const pending: Promise<void>[] = [];
    for (const state of this.consumers.values()) {
      if (state.reconnect) clearTimeout(state.reconnect);
      const child = state.child;
      if (!child) continue;
      pending.push(new Promise<void>((resolveExit) => {
        if (child.exitCode !== null) return resolveExit();
        child.once("close", () => resolveExit());
        child.stdin.end();
        const timer = setTimeout(() => child.kill("SIGTERM"), 1_500);
        timer.unref?.();
      }));
    }
    await Promise.all(pending);
    this.consumers.clear();
    this.handlers = undefined;
    this.log("info", "飞书监听已停止");
  }

  async sendCard(chatId: string, snapshot: CardSnapshot): Promise<string> {
    const card = buildLarkCard(snapshot);
    const output = await runLarkCliWithData(this.command, {
      receive_id: chatId,
      msg_type: "interactive",
      content: JSON.stringify(card),
      uuid: randomUUID(),
    }, (file) => [
      "api", "POST", "/open-apis/im/v1/messages",
      "--params", JSON.stringify({ receive_id_type: "chat_id" }),
      "--data", file, "--as", "bot", "--json",
    ]);
    const messageId = findField(JSON.parse(output) as unknown, "message_id");
    if (!messageId) throw new Error("飞书卡片发送成功但未返回消息 ID");
    this.cards.set(messageId, {
      chatId,
      ownerOpenId: snapshot.ownerOpenId,
      sessionId: snapshot.sessionId,
      snapshot,
    });
    this.log("info", "飞书运行卡片已发送");
    return messageId;
  }

  async updateCard(cardMessageId: string, snapshot: CardSnapshot): Promise<void> {
    const old = this.cards.get(cardMessageId);
    if (!old || old.sessionId !== snapshot.sessionId || old.ownerOpenId !== snapshot.ownerOpenId) {
      throw new Error("飞书卡片会话不匹配");
    }
    if (snapshot.version <= old.snapshot.version) throw new Error("飞书卡片版本未递增");
    await runLarkCliWithData(this.command, {
      content: JSON.stringify(buildLarkCard(snapshot)),
    }, (file) => [
      "api", "PATCH", `/open-apis/im/v1/messages/${encodeURIComponent(cardMessageId)}`,
      "--data", file, "--as", "bot", "--json",
    ]);
    this.cards.set(cardMessageId, { ...old, snapshot });
    this.log("info", "飞书运行卡片已更新");
  }

  async sendText(chatId: string, value: string): Promise<void> {
    await sendLarkText(this.command, chatId, value);
    this.log("info", "飞书文字消息已发送");
  }

  async sendImage(chatId: string, path: string): Promise<void> {
    await sendLarkMedia(this.command, chatId, "image", path);
    this.log("info", "飞书图片已发送");
  }

  async sendFile(chatId: string, path: string): Promise<void> {
    await sendLarkMedia(this.command, chatId, "file", path);
    this.log("info", "飞书文件已发送");
  }

  async addReaction(messageId: string, emojiType: string): Promise<string> {
    const output = await runLarkCli(this.command, [
      "im", "reactions", "create", "--message-id", messageId,
      "--data", JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
      "--as", "bot", "--json",
    ]);
    const reactionId = findField(JSON.parse(output) as unknown, "reaction_id");
    if (!reactionId) throw new Error("飞书表情添加成功但未返回表情 ID");
    this.log("info", "飞书处理表情已添加");
    return reactionId;
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    await runLarkCli(this.command, [
      "im", "reactions", "delete", "--message-id", messageId,
      "--reaction-id", reactionId, "--as", "bot", "--json",
    ]);
    this.log("info", "飞书处理表情已清理");
  }

  private async startConsumer(key: string): Promise<void> {
    if (!this.running) return;
    const state: Consumer = {};
    this.consumers.set(key, state);
    const child = spawn(this.command.cliPath, [
      "--profile", this.command.profile, "event", "consume", key, "--as", "bot",
    ], {
      windowsHide: true,
      stdio: "pipe",
      env: {
        ...process.env,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
      },
    });
    state.child = child;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let ready = false;
    await new Promise<void>((resolveReady, rejectReady) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        rejectReady(new Error(`飞书 ${key} 监听启动超时`));
      }, 20_000);
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) this.handleEventLine(key, line);
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderrBuffer += chunk;
        const lines = stderrBuffer.split(/\r?\n/);
        stderrBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.includes(`[event] ready event_key=${key}`) && !ready) {
            ready = true;
            clearTimeout(timer);
            resolveReady();
          }
        }
      });
      child.once("error", () => {
        clearTimeout(timer);
        if (!ready) rejectReady(new Error(`飞书 ${key} 监听无法启动`));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        state.child = undefined;
        if (!ready) rejectReady(new Error(`飞书 ${key} 监听提前退出（${code ?? "unknown"}）`));
        if (this.running) {
          this.log("warn", `飞书 ${key} 监听断开，稍后重连`);
          state.reconnect = setTimeout(() => {
            state.reconnect = undefined;
            void this.startConsumer(key).catch(() => this.log("error", `飞书 ${key} 重连失败`));
          }, 3_000);
        }
      });
    });
  }

  private handleEventLine(key: string, line: string): void {
    if (!this.running || !line.trim()) return;
    let value: unknown;
    try { value = JSON.parse(line); } catch {
      this.log("warn", "飞书事件 JSON 无法解析");
      return;
    }
    if (key === MESSAGE_EVENT) void this.handleMessage(value);
    else void this.handleAction(value);
  }

  private async handleMessage(value: unknown): Promise<void> {
    const incoming = normalizeLarkInboundEvent(value, this.settings, this.botOpenId);
    if (!incoming || this.seenMessageIds.has(incoming.messageId)) return;
    this.remember(this.seenMessageIds, incoming.messageId);
    try {
      const output = await runLarkCli(this.command, [
        "im", "+messages-mget", "--message-ids", incoming.messageId,
        "--download-resources", "--no-reactions", "--as", "bot", "--json",
      ], { cwd: this.workDir, timeoutMs: 120_000 });
      const hydrated = hydrateLarkMessage(JSON.parse(output) as unknown, incoming, this.workDir);
      await this.handlers?.onMessage(hydrated);
      this.log("info", `飞书消息已接收（${hydrated.attachments.length} 个附件）`);
    } catch {
      this.seenMessageIds.delete(incoming.messageId);
      this.log("error", "飞书消息读取或转交失败");
    }
  }

  private async handleAction(value: unknown): Promise<void> {
    const event = normalizeLarkCardAction(value);
    if (!event || this.seenActionIds.has(event.eventId)) return;
    const card = this.cards.get(event.cardMessageId);
    const runningStop = event.action === "stop" && card?.snapshot.status === "running"
      && event.version <= card.snapshot.version;
    if (!card || card.chatId !== event.chatId || card.ownerOpenId !== event.actorOpenId
      || card.sessionId !== event.sessionId || (!runningStop && card.snapshot.version !== event.version)) {
      this.log("warn", "飞书卡片回调已拒绝：操作者、会话或版本不匹配");
      return;
    }
    const actionVersion = `${event.cardMessageId}:${event.version}`;
    if (this.usedCardVersions.has(actionVersion)) return;
    if ((event.action === "stop" && card.snapshot.status !== "running")
      || (event.action === "answer" && card.snapshot.status !== "question")
      || (event.action === "approve" && card.snapshot.status !== "approval")
      || (event.action === "deny" && card.snapshot.status !== "approval" && card.snapshot.status !== "question")) return;
    this.remember(this.seenActionIds, event.eventId);
    this.remember(this.usedCardVersions, actionVersion);
    try {
      await this.handlers?.onAction({
        cardMessageId: event.cardMessageId,
        actorOpenId: event.actorOpenId,
        action: event.action,
        ...(event.value ? { value: event.value } : {}),
        version: event.version,
      });
      this.log("info", `飞书卡片回调已处理（${event.action}，卡片版本 ${event.version}）`);
    } catch {
      this.usedCardVersions.delete(actionVersion);
      this.log("error", "飞书卡片回调处理失败");
      return;
    }
    const updated = this.cards.get(event.cardMessageId);
    if (!updated || updated.snapshot.version <= event.version) return;
    try {
      await runLarkCliWithData(this.command, {
        token: event.callbackToken,
        card: buildLarkCard(updated.snapshot),
      }, (file) => [
        "api", "POST", "/open-apis/interactive/v1/card/update",
        "--data", file, "--as", "bot", "--json",
      ]);
      this.log("info", "飞书卡片按钮反馈已更新");
    } catch {
      this.log("warn", "飞书卡片按钮反馈更新失败");
    }
  }

  private remember(set: Set<string>, id: string): void {
    set.add(id);
    if (set.size > 2_000) {
      const oldest = set.values().next().value;
      if (oldest) set.delete(oldest);
    }
  }
}
