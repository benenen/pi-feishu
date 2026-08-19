import type { SendTarget } from "./types.ts";

/**
 * pi-asd 子 agent 的来源登记：`session 名 → 当初把活派给它的那个对话`。
 *
 * ## 为什么需要这张表
 *
 * pi-asd 的 watcher 在子 agent 停下来时会推一条 `pi.sendMessage(...,
 * { triggerTurn: true })`。boss 那时通常是闲着的 —— 这正是 watcher 的设计目的 ——
 * 于是 pi 走 `sendCustomMessage` 的 `triggerTurn` 分支直接 `_runAgentPrompt`，
 * **绕开了 `prompt()`，也就不发 `before_agent_start`**。
 *
 * 而 `before_agent_start.prompt` 是 `origin-registry.ts` 唯一那把「回合 ↔ 消息」
 * 的钥匙。事件不发 = 认领不到 = `turnTarget` 退回网关的默认收件方。实测症状：
 * 在群里 @ 派的活，一分五十秒后结果掉进了操作员的私聊。
 *
 * 所以这类**自主回合**需要另一把钥匙。pi-asd 的推送在 `details.session` 里报出
 * 它说的是哪个 session，而派活那次工具调用发生在一个**有来源**的回合里 ——
 * 把那时的出站目标按 session 名记下来，推送到达时回查即可。
 *
 * ## 和 `MessageOriginRegistry` 的分工
 *
 * 那张表按 messageId 索引，回答「这个回合是谁发起的」；这张按 session 名索引，
 * 回答「这个子 agent 是谁派的」。前者永远优先 —— 推送并入一个正在跑的回合时
 * （boss 当时正忙，走的是 followUp 队列）来源是认领得到的，这张表不该插手。
 *
 * ## 已知边界
 *
 * `asd_rename` 改名之后旧绑定就查不到了（新名字没登记过），推送退回默认收件方 ——
 * 也就是没修之前的行为，不会发给**错误**的对话。改名很少见，不为它加一条特例。
 */
export class AgentOriginRegistry {
  /** 插入序即淘汰序 —— Map 的迭代顺序就是插入顺序 */
  #bySession = new Map<string, SendTarget>();

  get size(): number {
    return this.#bySession.size;
  }

  /**
   * 记下「这个 session 是从这个对话派出去的」。
   *
   * 同名再 bind 就是改派：先删再插，让它重新排到淘汰序末尾 —— 否则一个被反复
   * steer 的长期 agent 会因为「第一次登记得早」而先被淘汰掉。
   */
  bind(session: string, target: SendTarget): void {
    this.#bySession.delete(session);
    this.#bySession.set(session, target);
    while (this.#bySession.size > MAX_AGENT_ORIGINS) {
      const oldest = this.#bySession.keys().next();
      if (oldest.done) break;
      this.#bySession.delete(oldest.value);
    }
  }

  targetOf(session: string | undefined): SendTarget | undefined {
    if (session === undefined) return undefined;
    return this.#bySession.get(session);
  }
}

/**
 * 记录上限。一条记录几十字节，但 boss 会话能跑几天，不设上限就是慢性泄漏。
 * 同时在跑的子 agent 不会有这么多，够用。
 */
export const MAX_AGENT_ORIGINS = 100;

/** pi-asd 推送用的自定义消息类型，见 pi-asd 的 `extensions/asd/index.ts`。 */
export const AGENT_NOTICE_TYPE = "pi-asd-agent";

/**
 * 哪些 pi-asd 工具算「把活派给了这个 session」。
 *
 * 判据是**这次调用之后会不会有 watcher 推送回来**：
 * - `asd_spawn` 派活，`asd_steer` 追加任务，两者都会挂/续上 watcher
 * - `asd_follow` 就是显式要求盯着它，推送正是它的产物
 * - `asd_nav` 替对话框按键，watcher 随后自动重挂，结果该回给按键的人
 *
 * `asd_peek` 故意不在里面：它只读一屏、不挂 watcher，不会引出任何推送。把它算进来
 * 只会让「某人顺手看了一眼」改写掉真正派活那个对话的绑定。`asd_kill` /
 * `asd_unmonitor` 同理 —— 它们的方向是不再有推送。
 */
const DISPATCH_TOOLS = new Set(["asd_spawn", "asd_steer", "asd_follow", "asd_nav"]);

/**
 * 从 `tool_execution_end` 的结果里认出这次调用交给了哪个 session。
 *
 * 读 `details.session` 而不是解析工具返回的正文：正文是给模型读的，措辞随时会改。
 *
 * **不看 `isError`**：pi-asd 的不变量 6 规定，`sendText` 拿到 ACK 之后哪怕拿不到
 * 回显证据也要保留控制权 —— session 照样进台账、照样挂 watcher。那种「投递未确认」
 * 的失败返回之后仍然可能有推送发过来，漏绑就等于漏路由。
 */
export function dispatchedSessionOf(toolName: string, result: unknown): string | undefined {
  if (!DISPATCH_TOOLS.has(toolName)) return undefined;
  const details = (result as { details?: unknown } | undefined)?.details;
  return sessionField(details);
}

/**
 * 从 `message_start` 的消息里认出「这是 pi-asd 的 watcher 推送」，并取出 session。
 *
 * 只认 `customType` + `details.session` 这一对结构化字段。**不许**退回去解析正文里的
 * `agent "xxx"` —— 那是一句给模型看的中文，拿它当协议，pi-asd 改一次措辞这里就静默失灵。
 * 认不出就返回 undefined，路由退回默认收件方（也就是没修之前的行为）。
 */
export function noticeSessionOf(message: unknown): string | undefined {
  const m = message as { role?: unknown; customType?: unknown; details?: unknown } | undefined;
  if (m?.role !== "custom" || m.customType !== AGENT_NOTICE_TYPE) return undefined;
  return sessionField(m.details);
}

function sessionField(details: unknown): string | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const session = (details as { session?: unknown }).session;
  if (typeof session !== "string" || session.trim() === "") return undefined;
  return session;
}
