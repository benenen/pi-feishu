import type { Config } from "./config.ts";
import { gateInbound } from "./gate.ts";
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
  /** 是否正在等待配对码。刻意不接收码本身 —— 这段文字会发进飞书 */
  pairingPending?: boolean;
  streaming?: boolean;
  /** 操作员是否点过「本回合全部允许」 */
  turnApproved?: boolean;
  /**
   * broker 档：与 broker 进程的连接是否还活着。
   * 扩展侧「运行中」只看 gateway 存不存在，断线后仍为真 —— 少了这一项，
   * 状态会理直气壮地说「运行中 · 绑定会话：oc_x」，而实际上什么都发不出去。
   */
  brokerConnected?: boolean;
}

/**
 * 飞书侧 `/feishu unbind` 的回执。
 *
 * broker 档下解绑**不签发新配对码**（绑定权在 broker 手里，签发要回终端），
 * 沿用 direct 那句「下一条消息会重新绑定会话」会把人卡在飞书里等一个永远
 * 不会发生的绑定 —— 下一条消息只会被 broker 回一句「请发送配对码」。
 */
export function renderUnbindNotice(transport: "direct" | "broker"): string {
  return transport === "broker"
    ? "已解绑。broker 模式下不会自动签发新配对码，请回终端执行 `/feishu pair` 取码，再把它发到要绑定的对话里。"
    : "已解绑，下一条消息会重新绑定会话。";
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
  const isBroker = c.transport === "broker";

  // broker 档下 bindTarget 的 operator / oc_xxx / none 三档全被忽略（绑定权在
  // broker 的路由表里），照着它推绑定方式会说出「启动时私信操作员绑定」这种
  // 根本没发生过的事
  const bindWay = isBroker
    ? "由 broker 按配对码绑定"
    : c.bindTarget === "operator"
      ? "启动时私信操作员绑定"
      : c.bindTarget === "none"
        ? "等首条消息绑定"
        : c.bindTarget === "code"
          ? "配对码绑定"
          : `启动时直接绑定 ${c.bindTarget}`;

  const transport = isBroker
    ? `broker · ${info.brokerConnected === false ? "**连接已断开**" : "已连接"} · ${c.brokerSocket}`
    : "direct（本会话自己连飞书）";

  const named =
    info.boundChatName !== undefined && info.boundChatName !== ""
      ? `${info.boundChatName} · ${info.boundChatId}`
      : `${info.boundChatId}`;
  // broker 档下本地没有 pairing 的概念，且「下一条消息会绑定它」是反的 ——
  // 未配对时下一条消息只会被 broker 回一句「请发送配对码」
  // 文案与真实准入规则用同一个判定，别各推各的 —— 已经漂过一次
  const gate = gateInbound({
    bound: false,
    multiChat: c.multiChat,
    requireCode: c.bindTarget === "code",
    codePending: info.pairingPending === true,
    codeMatched: false,
  });
  const unbound = isBroker
    ? "尚未绑定 —— 在要绑定的对话里发送终端上显示的配对码（`/feishu pair` 可重新取码）"
    : gate === "pass"
      ? `尚未绑定，下一条通过策略的消息会绑定它（${c.multiChat ? "multiChat：不要求配对" : bindWay}）`
      : info.pairingPending
        ? "等待配对 —— 在要绑定的对话里发送终端上显示的配对码"
        : "尚未绑定，且当前没有有效的配对码 —— 所有消息都会被挡。在终端跑 `/feishu pair` 取新码";
  const bound = info.boundChatId !== undefined ? `${named}（${bindWay}）` : unbound;

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
    `· 传输：${transport}`,
    `· 绑定会话：${bound}`,
    `· 当前：${turn}${exempt}`,
    `· 私聊：${dm}`,
    `· 群聊：${group}`,
    `· 审批：${c.approvalMode} · 超时 ${formatDuration(c.approvalTimeoutMs)} · 审批人 ${c.approverAllowlist.length} 人${custom}`,
    `· 仓库根：${c.repoRoot}`,
  ].join("\n");
}
