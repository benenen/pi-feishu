export interface AppendSink {
  append(chunk: string): Promise<void>;
}

/**
 * 把增量追加改写成「每次给累计全文」，专治飞书 SDK 流式 controller 的猜测式合并。
 *
 * SDK 的 `append()` 不知道生产者给的是增量还是累计，只能猜
 * （`mergeStreamingText`，@larksuiteoapi/node-sdk 1.71.1 的 lib/index.js:96096）：
 * 新块以已有内容开头就当累计，否则**取已有内容的尾巴与新块头部的最长重叠并去重**。
 *
 * 这个去重对真正的增量是有损的，而本扩展给的恰恰是增量（Bridge 逐段 push）：
 *
 * - `**lnny**` 被切成 `**ln` + `ny**` 时，尾巴的 `n` 与新块头部的 `n` 重叠，
 *   第二个 n 被吞掉，飞书上显示成粗体的 `lny` —— 少一个字母，且**毫无报错**
 * - 新块正好是已有内容的前缀时（`prev.startsWith(next)`）整块被丢掉
 *
 * 每次给累计全文就绕开了猜测：`next.startsWith(prev)` 恒成立，SDK 走精确分支
 * 原样采纳。它内部仍按差量累加当前卡片的 content，卡片滚动（rollover）不受影响。
 *
 * 另一个好处：下游抛错时累计量不回退，下一次追加会把漏掉的那段一并带过去。
 */
export function cumulativeSink(sink: AppendSink): AppendSink {
  let full = "";
  return {
    async append(chunk: string): Promise<void> {
      if (chunk === "") return;
      full += chunk;
      await sink.append(full);
    },
  };
}

/**
 * pi 的事件是推过来的，飞书 channel.stream() 的 producer 是拉模型
 * （给你一个 controller，等你的 async 函数返回才算结束）。
 * TurnStream 是两者之间的带缓冲适配器。
 */
export class TurnStream {
  #queue: string[] = [];
  #done = false;
  #wake: (() => void) | undefined;
  #pumping = false;

  push(chunk: string): void {
    if (this.#done || chunk === "") return;
    this.#queue.push(chunk);
    this.#signal();
  }

  finish(): void {
    if (this.#done) return;
    this.#done = true;
    this.#signal();
  }

  get finished(): boolean {
    return this.#done;
  }

  /**
   * 单消费者。`#wake` 只有一个槽位，第二个并发的 pump 会覆盖掉前一个的
   * resolver，让它永久挂起且毫无症状 —— 所以直接拒绝，而不是静默出错。
   *
   * 注意：`sink.append` 抛错时，该批内容已从队列取出，不会重投；异常会原样
   * 抛给调用方，由它决定降级方式（bridge 会在回合结束时补发全文）。
   */
  async pump(sink: AppendSink): Promise<void> {
    if (this.#pumping) throw new Error("TurnStream 只能有一个 pump 在跑");
    this.#pumping = true;
    try {
      for (;;) {
        if (this.#queue.length > 0) {
          // 合并突发写入，减少飞书侧的更新次数
          const chunk = this.#queue.splice(0).join("");
          await sink.append(chunk);
          continue;
        }
        if (this.#done) return;
        await new Promise<void>((resolve) => {
          this.#wake = resolve;
        });
      }
    } finally {
      this.#pumping = false;
      this.#wake = undefined;
    }
  }

  #signal(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }
}
