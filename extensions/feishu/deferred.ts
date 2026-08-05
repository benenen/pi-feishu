export interface DeferredMessage {
  /** 放行时要靠它把原文登记回来源表，否则认领不到、答案会发回上一个对话 */
  messageId: string;
  chatId: string;
  text: string;
}

/**
 * 最多扣住多少条。一个回合可能跑很久，期间别的对话一直发消息的话，
 * 无上限地攒着既吃内存，也会在回合结束后突然炸出一串回合。
 */
export const MAX_DEFERRED = 20;

export interface ConversationTarget {
  chatId: string;
  /** undefined 表示私聊/普通群主干；话题之间必须严格区分 */
  threadId?: string;
}

export interface DeferState {
  /** 当前有回合在跑 */
  streaming: boolean;
  /** 同一对话里的 `!` 是用户显式要求立刻打断，不能为了拆卡片改成普通排队 */
  deliverAs?: "steer" | "followUp";
  /**
   * 当前回合的**有效**出站目标。注意不是 `#turnTarget` 原值 ——
   * 终端敲字发起的回合没有飞书来源，但流照样发往已绑定会话，
   * 只看原值会误判成「没有目标」而放行。
   */
  turnTarget: ConversationTarget | undefined;
  /** 当前这条入站消息所在的对话；查不到来源时按不同对话保守处理 */
  incomingTarget: ConversationTarget | undefined;
}

/**
 * 这条消息该不该扣住，等当前回合跑完再单独成一个回合。
 *
 * 为什么非扣不可：pi 把排队消息（followUp/steer）并进**同一个** agent 运行 ——
 * 只有一次 `agent_start`、一次 `agent_end`（见 pi-agent-core 的 agent-loop.js，
 * 取到 followUp 后是 `continue` 外层循环，不重新开一轮）。而本扩展是
 * 「一次 agent_start = 一条飞书流」，目标在 startTurn 那一刻就定死了。
 * 所以回合进行中来自别的对话的消息，答案会整段发进**上一个**对话，
 * 那个对话的人只看到一个表情，一个字的回复都收不到。
 *
 * 同一个对话也要扣：虽然目的地没错，但 followUp 的答案只会更新先前那张流式卡片，
 * 不会在后来那条问题下面创建新消息。飞书更新消息又不会把旧卡片置底，用户看到的
 * 就是「pi 已经做完，但聊天里没有回复」。一条消息单独成一个 run，才真正是一问一卡。
 */
export function shouldDefer(s: DeferState): boolean {
  if (!s.streaming) return false;
  // 没有明确目标说明没什么要保护的（未绑定、也没人从飞书说过话）
  if (s.turnTarget === undefined) return false;
  // 只准当前回合所在的对话打断；另一个对话的 ! 直接 steer 会劫持当前任务，
  // 而回答仍留在旧目标，那边反而一条回复都收不到。
  if (
    s.deliverAs === "steer" &&
    s.incomingTarget !== undefined &&
    s.turnTarget.chatId === s.incomingTarget.chatId &&
    s.turnTarget.threadId === s.incomingTarget.threadId
  ) return false;
  return true;
}

export class DeferredQueue {
  #items: DeferredMessage[] = [];

  get size(): number {
    return this.#items.length;
  }

  /** 满了返回 false —— 由调用方当场告诉发送者，而不是静默丢掉 */
  push(msg: DeferredMessage): boolean {
    // 满时拒收新的而不是挤掉旧的：旧的那些已经答应过人家「稍后回复」，
    // 挤掉就是失约，而且失约的那个人永远不会知道
    if (this.#items.length >= MAX_DEFERRED) return false;
    this.#items.push(msg);
    return true;
  }

  shift(): DeferredMessage | undefined {
    return this.#items.shift();
  }

  /** 取出全部并清空 —— 停止桥接时要挨个告知，不能让人干等 */
  takeAll(): DeferredMessage[] {
    const all = this.#items;
    this.#items = [];
    return all;
  }
}
