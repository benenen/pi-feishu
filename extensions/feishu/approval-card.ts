import { randomUUID } from "node:crypto";
import type { ApprovalRequest, Decision } from "./approval.ts";
import type { LogFn } from "./log.ts";

export const APPROVAL_KIND = "pi-feishu-approval";

/** 飞书对单个卡片元素有大小限制，命令正文必须截断 */
const MAX_DETAIL_CHARS = 800;

function detailOf(req: ApprovalRequest): string {
  if (typeof req.input.command === "string") return req.input.command;
  if (typeof req.input.path === "string") return req.input.path;
  return JSON.stringify(req.input);
}

/**
 * 这是人做审批决策时唯一看得见的东西，必须忠实呈现。
 * - 反引号换成单引号：三个反引号会终止代码围栏，让命令后半截以粗体正文
 *   的样子渲染，或者干脆藏到截断之外
 * - 按码点截断：切断代理对会让整张卡片发送失败，等于静默瘫痪审批通道
 */
function safeDetail(text: string): string {
  const neutralized = text.replace(/`/g, "'");
  const points = Array.from(neutralized);
  return points.length <= MAX_DETAIL_CHARS
    ? neutralized
    : `${points.slice(0, MAX_DETAIL_CHARS - 1).join("")}…`;
}

/**
 * `update_multi: true` = 共享卡片，**不是可选的**。
 *
 * 收尾走的 `im.v1.message.patch` 只能更新共享卡片；默认的独享卡片是每个接收者
 * 一份独立副本，patch 改不动。症状很迷惑：点「允许」后 pi 照常放行（审批那边
 * 是兑现了的），但卡片上的按钮一直杵在那儿，看不出批没批过，也不知道该不该再点。
 */
const CARD_CONFIG = { wide_screen_mode: true, update_multi: true };

export function buildApprovalCard(id: string, req: ApprovalRequest): object {
  const detail = safeDetail(detailOf(req));
  return {
    config: CARD_CONFIG,
    header: {
      template: "orange",
      title: { tag: "plain_text", content: `⚠️ 需要审批：${req.toolName}` },
    },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: `\`\`\`\n${detail}\n\`\`\`` } },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "允许" },
            type: "primary",
            value: { kind: APPROVAL_KIND, id, allow: true },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "本回合全部允许" },
            type: "default",
            value: { kind: APPROVAL_KIND, id, allow: true, scope: "turn" },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "拒绝" },
            type: "danger",
            value: { kind: APPROVAL_KIND, id, allow: false },
          },
        ],
      },
    ],
  };
}

export function buildSettledCard(status: string): object {
  return {
    config: CARD_CONFIG,
    elements: [{ tag: "div", text: { tag: "lark_md", content: `**${status}**` } }],
  };
}

export function parseApprovalAction(
  value: unknown,
): { id: string; allow: boolean; scope?: "turn" } | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const v = value as { kind?: unknown; id?: unknown; allow?: unknown; scope?: unknown };
  if (v.kind !== APPROVAL_KIND || typeof v.id !== "string") return undefined;
  // 只有显式 true 才算批准
  const allow = v.allow === true;
  // scope 只认字面量 "turn"，别的值一律当普通批准 —— 卡片 value 是从飞书回来的外部输入
  return allow && v.scope === "turn" ? { id: v.id, allow, scope: "turn" } : { id: v.id, allow };
}

/** 显式收件方优先；都没有时返回 undefined，调用方应放弃发送 */
export function resolveTarget(
  bound: string | undefined,
  explicit?: string,
): string | undefined {
  return explicit ?? bound;
}

interface PendingEntry {
  resolve: (d: Decision) => void;
  messageId: string;
  /** 卡片发往了哪个会话。来自别处的点击一律不算数 */
  chatId: string;
}

/** 未决审批登记表。每个 id 至多兑现一次。 */
export class ApprovalRegistry {
  #pending = new Map<string, PendingEntry>();

  get size(): number {
    return this.#pending.size;
  }

  register(id: string, messageId: string, chatId: string): Promise<Decision> {
    return new Promise<Decision>((resolve) => {
      this.#pending.set(id, { resolve, messageId, chatId });
    });
  }

  /** 卡片发往的会话；未知 id 返回 undefined */
  chatOf(id: string): string | undefined {
    return this.#pending.get(id)?.chatId;
  }

  /**
   * 兑现并移除；返回该审批的卡片 messageId，未知 id 返回 undefined。
   *
   * `fromChatId` 给出时必须与登记时的会话一致，否则拒绝兑现 —— 卡片发给谁，
   * 就只认谁那边的点击。内部撤销（cancel / cancelAll）不传这个参数，
   * 它们本来就不是「某个会话点的」。
   */
  settle(id: string, decision: Decision, fromChatId?: string): string | undefined {
    const entry = this.#pending.get(id);
    if (!entry) return undefined;
    if (fromChatId !== undefined && fromChatId !== entry.chatId) return undefined;
    this.#pending.delete(id);
    entry.resolve(decision);
    return entry.messageId;
  }

  /** settle 的别名，仅用于在调用点表达「是被撤销的，不是被回答的」 */
  cancel(id: string, decision: Decision): string | undefined {
    return this.settle(id, decision);
  }

  /** 全部兑现并移除；返回被撤销的卡片 messageId，供调用方把卡片收到终态 */
  cancelAll(decision: Decision): string[] {
    const settled: string[] = [];
    for (const id of [...this.#pending.keys()]) {
      const messageId = this.settle(id, decision);
      if (messageId !== undefined) settled.push(messageId);
    }
    return settled;
  }
}

/** 卡片点击事件里鉴权用得到的那几个字段。刻意不依赖飞书 SDK 的类型 */
export interface CardActionLike {
  chatId: string;
  operator: { openId: string };
  action: { value: unknown };
}

/** 该收到终态的卡片，以及要写上去的文案 */
export interface CardSettlement {
  messageId: string;
  status: string;
}

export interface CardActionInput {
  registry: ApprovalRegistry;
  event: CardActionLike;
  approverAllowlist: string[];
  /**
   * direct 档传 true 并给出 boundChatId：点击还必须来自**当前**绑定的会话，
   * 未绑定（boundChatId 为 undefined）时一律拒。
   *
   * broker 档不传 —— 一个 broker 服务多个对话，「当前绑定」是每个 pi 会话
   * 各自的概念，不在这一层；这一层由登记时记下的 chatId 兜住。
   */
  requireBoundChat?: boolean;
  boundChatId?: string;
  log: LogFn;
}

/**
 * 卡片点击的统一处理：解析 → 鉴权 → 兑现 → 交回该收尾的卡片。
 *
 * 飞书 SDK 只对 `im.message.receive_v1` 走完整的策略管道；`card.action.trigger`
 * **只有去重和串行化，没有任何白名单过滤**。不自己鉴权的话，群里任何看得见卡片
 * 的人都能点「允许」—— 让 agent 干活的人自己批准自己，闸门等于没有。
 *
 * direct（feishu.ts）与 broker（broker/channel.ts）两档共用这一份实现：
 * 这段逻辑曾经是逐字复制的两份，并且**已经漂过一次** —— broker 版把会话校验
 * 整个漏掉了，任何 allowlist 成员在任何对话里都能点动别人的卡片。
 */
export function handleCardAction(input: CardActionInput): CardSettlement | undefined {
  const { registry, event, approverAllowlist, log } = input;
  const action = parseApprovalAction(event.action.value);
  if (!action) return undefined;

  if (input.requireBoundChat === true && event.chatId !== input.boundChatId) {
    log(`忽略来自未绑定会话的卡片点击：${event.chatId}`, "warning");
    return undefined;
  }
  if (!approverAllowlist.includes(event.operator.openId)) {
    log(`忽略非授权审批人的卡片点击：${event.operator.openId}`, "warning");
    return undefined;
  }
  // 先查一次只是为了能报出有用的日志；真正的拦截在下面的 settle 里，
  // 那一层任何调用方都绕不过去
  const registered = registry.chatOf(action.id);
  if (registered !== undefined && registered !== event.chatId) {
    log(`忽略来自其他会话的卡片点击：卡片发往 ${registered}，点击来自 ${event.chatId}`, "warning");
    return undefined;
  }

  const turn = action.scope === "turn";
  const messageId = registry.settle(
    action.id,
    {
      allow: action.allow,
      reason: turn ? "飞书批准（本回合全部允许）" : action.allow ? "飞书批准" : "飞书拒绝",
      ...(turn ? { scope: "turn" as const } : {}),
    },
    event.chatId,
  );
  if (messageId === undefined) return undefined;
  return {
    messageId,
    status: turn ? "已批准（本回合全部允许）" : action.allow ? "已批准" : "已拒绝",
  };
}

export interface AskViaCardInput {
  registry: ApprovalRegistry;
  /** 卡片发往哪个会话 */
  chatId: string;
  req: ApprovalRequest;
  signal: AbortSignal;
  /** 发出审批卡片，返回它的 messageId */
  send: (chatId: string, card: object) => Promise<string>;
  /** 把卡片收到终态。实现方需自我兜底，不得抛 */
  settleCard: (messageId: string, status: string) => Promise<void>;
}

/**
 * 发一张审批卡片并等它被兑现。direct 的 `cardAsker` 与 broker 的 `askCard`
 * 共用这一份实现 —— 两边只是「往哪个会话发」的来源不同。
 *
 * 竞速（飞书卡片 vs 终端对话框）可能在卡片还没发出去时就被别的通道结束掉。
 * abort 事件不会补发给事后才挂上的监听器，所以必须在 await 之前就把它接住。
 */
export async function askViaCard(input: AskViaCardInput): Promise<Decision> {
  const { registry, chatId, req, signal, send, settleCard } = input;
  if (signal.aborted) return { allow: false, reason: "已由其他通道处理" };

  let aborted = false;
  let onAbort: (() => void) | undefined;
  const abortedEarly = new Promise<void>((resolve) => {
    onAbort = () => {
      aborted = true;
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

  // 随机 id：每实例从 1 开始重编号的话，旧会话残留的卡片被点一下
  // 就会兑现新会话的 ap-1 —— 操作员从未见过的审批被凭空批准
  const id = `ap-${randomUUID()}`;
  try {
    const messageId = await send(chatId, buildApprovalCard(id, req));

    if (aborted) {
      // 竞速已结束，这张卡片刚发出来就作废，直接收到终态
      await settleCard(messageId, "已在终端处理");
      return { allow: false, reason: "已由其他通道处理" };
    }

    const pending = registry.register(id, messageId, chatId);
    void abortedEarly.then(() => {
      const stranded = registry.cancel(id, { allow: false, reason: "已由其他通道处理" });
      if (stranded) void settleCard(stranded, "已在终端处理");
    });

    return await pending;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
