import type { Config } from "./config.ts";
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m${total % 60}s`;
}

export function formatTokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}

/**
 * 压平换行、折叠空白、超长截断。
 * 按码点而非 UTF-16 码元切，否则 emoji 会被劈成孤立代理项 —— 飞书是聊天
 * 场景，emoji 是必然会遇到的。
 */
function flatten(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  const points = Array.from(one);
  return points.length <= max ? one : `${points.slice(0, max - 1).join("")}…`;
}

/** 反引号会撑破 markdown 代码片段，替换成单引号 */
function codeSpan(text: string): string {
  return `\`${text.replace(/`/g, "'")}\``;
}

/**
 * 中和会撑破粗体/代码片段的字符，用于直接插进 markup 的字段。
 * 不动下划线 —— `ask_question` 这类工具名里它很常见，剥掉反而是破坏。
 */
function plain(text: string, max: number): string {
  return flatten(text, max).replace(/[*`~]/g, "");
}

export function renderUserPrompt(
  text: string,
  source: "interactive" | "feishu",
): string | null {
  // 飞书发起的消息用户自己看得见，不必回显
  if (source !== "interactive") return null;
  return `> 💻 终端：${flatten(text, 200)}\n\n`;
}

export function renderToolStart(toolName: string, input: Record<string, unknown>): string {
  let detail = "";
  if (toolName === "bash" && typeof input.command === "string") {
    detail = flatten(input.command, 120);
  } else if (typeof input.path === "string") {
    detail = flatten(input.path, 120);
  }
  const name = plain(toolName, 40);
  return detail === ""
    ? `\n⚙️ **${name}**\n`
    : `\n⚙️ **${name}** ${codeSpan(detail)}\n`;
}

export function renderToolEnd(isError: boolean, elapsedMs: number): string {
  return isError
    ? `   ✗ 失败（${formatDuration(elapsedMs)}）\n`
    : `   ✓ ${formatDuration(elapsedMs)}\n`;
}

export function renderTurnEnd(elapsedMs: number, tokens: number): string {
  return `\n\n---\n⏱ ${formatDuration(elapsedMs)} · ${formatTokens(tokens)} tok`;
}

export function renderBlocked(toolName: string, reason: string): string {
  // reason 最终可能来自人工输入的拒绝理由，必须中和后再插进 markup
  return `\n🚫 已拦截 **${plain(toolName, 40)}** —— ${plain(reason, 200)}\n`;
}

export function renderNotice(text: string): string {
  return `\nℹ️ ${plain(text, 200)}\n`;
}

/**
 * 会话的人类可读名称。私聊在飞书那边没有名字（chat.get 的 name 返回 null），
 * 所以必须按类型退回一个说法，否则状态里会出现一段空白。
 */
export function chatLabel(info: { name?: string; chatType?: "p2p" | "group" }): string {
  if (info.name) return info.name;
  return info.chatType === "p2p" ? "私聊" : "群聊";
}

export interface StatusInfo {
  running: boolean;
  config?: Config;
  boundChatId?: string;
  /** 绑定会话的名称，查不到时省略 —— 不能因为查不到就不显示 id */
  boundChatName?: string;
  streaming?: boolean;
  /** 操作员是否点过「本回合全部允许」 */
  turnApproved?: boolean;
}

/**
 * /feishu status 的正文。终端和飞书两侧共用同一份渲染，避免两边说法不一致。
 * 刻意不含 appSecret —— 这段文字会原样发进飞书聊天记录。
 */
export function renderStatus(info: StatusInfo): string {
  if (!info.running || !info.config) {
    return "飞书桥接：未运行。在终端用 `/feishu start` 启动。";
  }
  const c = info.config;

  const bindWay =
    c.bindTarget === "operator"
      ? "启动时私信操作员绑定"
      : c.bindTarget === "none"
        ? "等首条消息绑定"
        : `启动时直接绑定 ${c.bindTarget}`;
  const named =
    info.boundChatName !== undefined && info.boundChatName !== ""
      ? `${info.boundChatName} · ${info.boundChatId}`
      : `${info.boundChatId}`;
  const bound =
    info.boundChatId !== undefined
      ? `${named}（${bindWay}）`
      : `尚未绑定，下一条通过策略的消息会绑定它（${bindWay}）`;

  const dm =
    c.dmMode === "open" ? "所有人可私聊" : `仅白名单 ${c.dmAllowlist.length} 人`;
  const group = `${c.requireMention ? "需要 @ 机器人" : "**不需要 @**（群里每条消息都会进来）"} · 群白名单：${
    c.groupAllowlist.length === 0 ? "不限" : `${c.groupAllowlist.length} 个`
  }`;

  // 配了自定义规则却看不到，就没法确认配置到底生效没有；没配则不提，免得添噪音
  const custom =
    c.denyPatterns.length + c.allowPatterns.length > 0
      ? ` · 自定义规则 deny ${c.denyPatterns.length} / allow ${c.allowPatterns.length}`
      : "";

  const turn = info.streaming ? "回合进行中" : "空闲";
  const exempt = info.turnApproved ? " · 已点「本回合全部允许」" : "";

  return [
    "飞书桥接：运行中",
    `· 应用：${c.appId}`,
    `· 绑定会话：${bound}`,
    `· 当前：${turn}${exempt}`,
    `· 私聊：${dm}`,
    `· 群聊：${group}`,
    `· 审批：${c.approvalMode} · 超时 ${formatDuration(c.approvalTimeoutMs)} · 审批人 ${c.approverAllowlist.length} 人${custom}`,
    `· 仓库根：${c.repoRoot}`,
  ].join("\n");
}
