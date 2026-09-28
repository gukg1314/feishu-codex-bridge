import { basename, isAbsolute, relative, resolve } from "node:path";

import type { BridgeSettings, IncomingMessage } from "./types.js";

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function postText(value: unknown): string {
  const post = record(value);
  if (!post) return "";
  if (typeof post.text === "string") return post.text;
  const locale = record(post.zh_cn) ?? record(post.en_us) ?? post;
  const lines = Array.isArray(locale.content) ? locale.content : [];
  return lines.map((line) => Array.isArray(line) ? line.map((item) => {
    const node = record(item);
    if (!node) return "";
    const text = string(node.text) ?? "";
    return node.tag === "a" && string(node.href) ? `[${text}](${node.href})` : text;
  }).join("") : "").join("\n");
}

export function larkMessageText(content: unknown, messageType?: string): string {
  if (typeof content === "string") {
    try {
      const parsed: unknown = JSON.parse(content);
      const decoded = typeof parsed === "string" ? parsed : postText(parsed);
      return decoded || (["image", "file", "audio", "video", "media"].includes(messageType ?? "") ? "" : content);
    } catch {
      return content;
    }
  }
  return postText(content);
}

export function normalizeLarkInboundEvent(
  value: unknown,
  settings: BridgeSettings,
  botOpenId: string | undefined,
): IncomingMessage | null {
  const event = record(value);
  if (!event || event.type !== "im.message.receive_v1") return null;
  const messageId = string(event.message_id) ?? string(event.id);
  const chatId = string(event.chat_id);
  const senderOpenId = string(event.sender_id);
  const senderType = string(event.sender_type);
  const chatType = string(event.chat_type);
  if (!messageId || !chatId || !senderOpenId || (chatType !== "p2p" && chatType !== "group")) return null;
  if (senderType && senderType !== "user") return null;
  if (senderOpenId === botOpenId || !settings.allowedOpenIds.includes(senderOpenId)) return null;
  if (event.message_type === "interactive" || event.message_type === "system") return null;

  let mentionsBot = false;
  if (chatType === "group") {
    if (!settings.allowGroupMentions || !settings.allowedChatIds.includes(chatId) || !botOpenId) return null;
    const mentions = Array.isArray(event.mentions) ? event.mentions : [];
    mentionsBot = mentions.some((item) => string(record(item)?.id) === botOpenId);
    if (!mentionsBot) return null;
  }

  return {
    messageId,
    chatId,
    chatType,
    senderOpenId,
    text: larkMessageText(event.content, string(event.message_type)),
    mentionsBot,
    ...(string(event.reply_to) ? { replyToMessageId: string(event.reply_to) } : {}),
    attachments: [],
  };
}

export function hydrateLarkMessage(
  value: unknown,
  incoming: IncomingMessage,
  downloadDir: string,
): IncomingMessage {
  const envelope = record(value);
  const data = record(envelope?.data) ?? envelope;
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  const message = messages.map(record).find((item) => string(item?.message_id) === incoming.messageId);
  if (!message) throw new Error("飞书未返回该消息的完整内容");

  const resources = Array.isArray(message.resources) ? message.resources : [];
  const attachments: IncomingMessage["attachments"] = [];
  for (const raw of resources) {
    const resource = record(raw);
    if (!resource) continue;
    if (resource.error === true) throw new Error("飞书附件下载失败");
    const localPath = string(resource.local_path);
    if (!localPath) continue;
    const filePath = isAbsolute(localPath) ? resolve(localPath) : resolve(downloadDir, localPath);
    const rel = relative(downloadDir, filePath);
    if (rel === ".." || rel.startsWith(`..${requireSeparator()}`) || isAbsolute(rel)) {
      throw new Error("飞书附件路径不在下载目录内");
    }
    attachments.push({
      kind: resource.type === "image" ? "image" : "file",
      path: filePath,
      name: string(resource.name) ?? basename(filePath),
    });
  }
  const isMedia = ["image", "file", "audio", "video", "media"].includes(string(message.msg_type) ?? "");
  if (isMedia && !attachments.length) {
    throw new Error("飞书消息附件未成功下载");
  }
  const replyTo = string(message.reply_to) ?? string(message.parent_id);
  return {
    ...incoming,
    text: isMedia
      ? incoming.text || attachments.map((item) => item.name ?? basename(item.path)).join("、")
      : larkMessageText(message.content) || incoming.text,
    ...(replyTo ? { replyToMessageId: replyTo } : {}),
    attachments,
  };
}

function requireSeparator(): string {
  return process.platform === "win32" ? "\\" : "/";
}
