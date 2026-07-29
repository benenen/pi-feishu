/**
 * 入站准入判定 —— 单一事实来源。
 *
 * 单独成一个无依赖模块，是因为它有两类消费者，而它们分居依赖链两端：
 *   - `index.ts` 用它决定一条消息是放行、要配对码、还是就是配对码
 *   - `renderer.ts` 用它生成 /feishu status 的文案
 * `bridge.ts` 依赖 `renderer.ts`，所以判定放在 bridge 里会让 renderer 反向引用成环。
 *
 * 更要紧的是：文案和真实规则必须由同一段代码推出来。两边各推一遍的话，
 * 每改一次准入规则就要记得同步改文案 —— 这种「记得」从来靠不住，
 * 已经漂过一次（multiChat 明明不要求配对，状态却显示「等待配对」）。
 */

/** 一条入站消息在准入这一层的三种去向 */
export type InboundGate = "pair-ok" | "need-code" | "pass";

export interface GateState {
  /** 是否已经绑定过会话 */
  bound: boolean;
  multiChat: boolean;
  /** bindTarget === "code" */
  requireCode: boolean;
  /** 当前是否有未过期的配对码 */
  codePending: boolean;
  /** 本条消息是否就是那个配对码。做状态展示时传 false 即可 */
  codeMatched: boolean;
}

/**
 * 两个反直觉的点，都在这里而不是散落在调用方：
 *
 * 1. **multiChat 不要求配对。** 它的语义就是「全接」，再要一次握手是自相矛盾 ——
 *    先绑上的那个对话之外的消息本来就会被放行，只有第一个要握手毫无道理。
 *    谁能触达由飞书侧的策略管道（dmMode / 白名单 / requireMention）决定。
 *
 * 2. **配对码过期后必须继续挡着。** 早先的写法是「有待配对码时才走配对分支」，
 *    于是码一过期这个分支整个被跳过，下一条消息不需要任何码就绑上了 ——
 *    到期让门消失而不是关得更严，是 fail-open。要重新拿码得回终端 /feishu pair。
 */
export function gateInbound(s: GateState): InboundGate {
  if (s.bound) return "pass";
  if (s.multiChat) return "pass";
  if (!s.requireCode) return "pass";
  return s.codePending && s.codeMatched ? "pair-ok" : "need-code";
}
