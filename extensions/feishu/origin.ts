/**
 * 从 pi 的会话条目里倒推「这个回合是哪个飞书对话触发的」。
 *
 * 为什么走这条路：pi 的 `agent_start` 事件是空的（`{ type: "agent_start" }`），
 * `sendUserMessage` 也收不了元数据，所以「回合 ↔ 来源」这个映射上游不提供。
 * 但 `pi.appendEntry(customType, data)` 能往会话里写自定义条目，而
 * `ctx.sessionManager.getEntries()` 能把它们按**实际顺序**读回来 —— 那份顺序
 * 是 pi 自己处理消息的 ground truth，比我们在旁边维护的队列或文本匹配都可靠：
 *
 *   - 不受「两个对话发了一模一样的文本」影响（按位置，不按文本）
 *   - 不受 steer / followUp 是否合并进当前回合影响（不需要「一回合一槽位」的前提）
 *   - 终端敲的消息前面没有来源条目，天然区分得出来
 *
 * 另一个关键性质：`appendEntry` 写出来的普通自定义条目**不进 LLM 上下文**
 * （见 pi 的 sessionEntryToContextMessages：plain custom entries do not
 * participate in context），所以 chatId 不会污染 agent 看到的对话。
 */
export const ORIGIN_ENTRY_TYPE = "pi-feishu-origin";

/** 只依赖判定用得上的那几个字段，避免把 pi 的会话类型拖进来 */
interface EntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
  message?: { role?: string };
}

/**
 * 倒着找最后一条用户消息，再看它前面**紧邻的**来源条目（中间允许夹别的条目，
 * 但不能跨过另一条用户消息 —— 跨过去就说明那条来源属于上一轮）。
 *
 * 找不到返回 undefined，调用方应退回默认收件方。
 */
export function resolveOrigin(entries: readonly EntryLike[]): string | undefined {
  let i = entries.length - 1;

  // 1) 定位最后一条用户消息
  while (i >= 0 && !(entries[i]?.type === "message" && entries[i]?.message?.role === "user")) {
    i -= 1;
  }
  if (i < 0) return undefined;

  // 2) 从它往前找来源条目，遇到另一条用户消息就停 —— 再往前的来源属于上一轮
  for (let j = i - 1; j >= 0; j -= 1) {
    const e = entries[j];
    if (e?.type === "message" && e.message?.role === "user") return undefined;
    if (e?.type === "custom" && e.customType === ORIGIN_ENTRY_TYPE) {
      const chatId = (e.data as { chatId?: unknown } | undefined)?.chatId;
      return typeof chatId === "string" && chatId !== "" ? chatId : undefined;
    }
  }
  return undefined;
}
