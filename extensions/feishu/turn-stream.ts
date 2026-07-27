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

  async pump(sink: AppendSink): Promise<void> {
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
  }

  #signal(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }
}
