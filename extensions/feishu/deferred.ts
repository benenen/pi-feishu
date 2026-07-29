export interface DeferredMessage {
  chatId: string;
  text: string;
}

/**
 * 最多扣住多少条。一个回合可能跑很久，期间别的对话一直发消息的话，
 * 无上限地攒着既吃内存，也会在回合结束后突然炸出一串回合。
 */
export const MAX_DEFERRED = 20;

export interface DeferState {
  /** 当前有回合在跑 */
  streaming: boolean;
  /**
   * 当前回合的**有效**出站目标。注意不是 `#turnTarget` 原值 ——
   * 终端敲字发起的回合没有飞书来源，但流照样发往已绑定会话，
   * 只看原值会误判成「没有目标」而放行。
   */
  turnTarget: string | undefined;
  chatId: string;
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
 * 同一个对话则不用扣：它并进当前回合，而当前回合的流就发往这个对话，本来就是对的。
 */
export function shouldDefer(s: DeferState): boolean {
  if (!s.streaming) return false;
  // 没有明确目标说明没什么要保护的（未绑定、也没人从飞书说过话）
  if (s.turnTarget === undefined) return false;
  return s.turnTarget !== s.chatId;
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
