import type { CardSnapshot } from "./types.js";

// Keep the Card 2.0 layout and callback shape of the original Lark workflow card.
export type { CardSnapshot } from "./types.js";

type CardElement = Record<string, unknown>;

export type LarkCard = {
  schema: "2.0";
  config: {
    update_multi: true;
    enable_forward: false;
    width_mode: "fill";
    summary: { content: string };
  };
  body: {
    direction: "vertical";
    padding: string;
    vertical_spacing: string;
    elements: CardElement[];
  };
};

function markdown(content: string): CardElement {
  return { tag: "markdown", content };
}

function button(
  snapshot: CardSnapshot,
  label: string,
  action: "stop_session" | "question_answer" | "permission_allow" | "permission_deny",
  answer?: string,
  type = "default",
): CardElement {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type,
    width: action === "stop_session" ? "default" : "fill",
    behaviors: [{
      type: "callback",
      value: {
        v: 1,
        action,
        sessionId: snapshot.sessionId,
        cardVersion: snapshot.version,
        ...(answer ? { answer } : {}),
      },
    }],
    ...(action === "stop_session" ? {
      confirm: {
        title: { tag: "plain_text", content: "停止当前任务？" },
        text: { tag: "plain_text", content: "Codex 将停止当前处理。" },
      },
    } : {}),
  };
}

function row(buttons: CardElement[]): CardElement {
  return {
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "8px",
    columns: buttons.map((item) => ({
      tag: "column",
      width: "weighted",
      weight: 1,
      elements: [item],
    })),
  };
}

function quotedPrompt(prompt: string): CardElement[] {
  const chars = Array.from(prompt.trim());
  const chunks: CardElement[] = [];
  for (let i = 0; i < chars.length; i += 600) {
    const chunk = chars.slice(i, i + 600).join("");
    chunks.push(markdown(`> ${chunk.replace(/\r?\n/g, "\n> ")}`));
  }
  return chunks;
}

function progressHistory(steps: { title: string; detail?: string }[]): CardElement[] {
  if (!steps.length) return [markdown("等待进度更新")];
  const chunks: string[] = [];
  steps.forEach((step, index) => {
    const entry = `${index + 1}. **${step.title}**${step.detail ? `\n   ${step.detail}` : ""}`;
    const last = chunks.length - 1;
    if (last < 0 || chunks[last].length + entry.length > 3000) chunks.push(entry);
    else chunks[last] += `\n\n${entry}`;
  });
  return chunks.map(markdown);
}

export function buildLarkCard(snapshot: CardSnapshot): LarkCard {
  const elements: CardElement[] = quotedPrompt(snapshot.prompt);
  const summary = snapshot.summary?.trim();
  if (snapshot.status === "running") {
    elements.push(markdown(`<font color='blue'>${snapshot.currentStep ? `正在执行 · ${snapshot.currentStep}` : "正在执行…"}</font>`));
    if (summary && summary !== "正在执行…") elements.push(markdown(`<font color='grey'>${summary}</font>`));
    const steps: { title: string; detail?: string }[] = snapshot.steps
      ?? snapshot.details?.map((detail) => ({ title: detail })) ?? [];
    elements.push({
      tag: "collapsible_panel",
      expanded: false,
      header: {
        title: { tag: "plain_text", content: "执行过程" },
        icon: { tag: "standard_icon", token: "right_outlined" },
        icon_position: "follow_text",
        icon_expanded_angle: 90,
      },
      elements: progressHistory(steps),
    });
    elements.push(row([button(snapshot, "停止", "stop_session")]));
  } else if (snapshot.status === "question" && snapshot.question) {
    if (summary && summary !== "等待回答") elements.push(markdown(summary));
    elements.push(markdown(`**请回答以下问题**\n${snapshot.question.text}`));
    const options = snapshot.question.options?.slice(0, 6) ?? [];
    if (options.length) {
      for (let i = 0; i < options.length; i += 2) {
        elements.push(row(options.slice(i, i + 2).map((option) =>
          button(snapshot, option, "question_answer", option, i === 0 ? "primary_filled" : "default"))));
      }
    } else {
      elements.push(markdown(snapshot.chatType === "group"
        ? "<font color='grey'>请回复这条飞书消息，并 @ 机器人。</font>"
        : "<font color='grey'>请直接回复这条飞书消息。</font>"));
    }
    elements.push(row([button(snapshot, "取消", "permission_deny")]));
  } else if (snapshot.status === "approval" && snapshot.approval) {
    if (summary && summary !== "等待审批") elements.push(markdown(summary));
    elements.push(markdown(`**等待确认**\n${snapshot.approval.title}${snapshot.approval.detail ? `\n${snapshot.approval.detail}` : ""}`));
    elements.push(row([
      button(snapshot, "允许一次", "permission_allow", undefined, "primary_filled"),
      button(snapshot, "拒绝", "permission_deny", undefined, "danger"),
    ]));
  } else if (snapshot.status === "stopped") {
    elements.push(markdown("<font color='grey'>已停止</font>"));
  } else if (snapshot.status === "failed") {
    if (summary) elements.push(markdown(summary));
    elements.push(markdown("<font color='red'>执行遇到问题</font>"));
  } else if (summary) {
    elements.push(markdown(summary));
  }

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      enable_forward: false,
      width_mode: "fill",
      summary: { content: `Codex · ${snapshot.status === "running" ? "正在执行" : snapshot.status === "completed" ? "已完成" : snapshot.status === "stopped" ? "已停止" : snapshot.status === "failed" ? "失败" : "等待回复"}` },
    },
    body: {
      direction: "vertical",
      padding: "12px 16px 12px 16px",
      vertical_spacing: "6px",
      elements,
    },
  };
}
