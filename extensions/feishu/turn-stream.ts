export interface AppendSink {
  append(chunk: string): Promise<void>;
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
