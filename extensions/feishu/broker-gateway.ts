import net from "node:net";
import { encodeFrame, FrameReader, type ClientFrame, type ServerFrame } from "./broker/protocol.ts";
import type { AppendSink } from "./turn-stream.ts";
import type { GatewayLike } from "./bridge.ts";
import type { InboundMessage } from "./types.ts";
import type { Asker, Decision } from "./approval.ts";
import type { LogFn } from "./log.ts";

interface Pending {
  resolve: (f: ServerFrame) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * 单次请求等 broker 响应的上限。
 *
 * broker 侧任何一处漏回帧（吞掉异常、进程被 SIGSTOP、内部 bug），没有超时的话
 * pending 就永远不会 settle —— 而 `Bridge.endTurn()` 正好 await 它，结果是 agent
 * 回合永久冻住，只能重启 pi。30 秒远大于飞书 API 的正常往返（百毫秒级），又短到
 * 不会让人误以为 pi 死了。
 *
 * 例外是审批（`ask`）：人点按钮本来就可能超过 30 秒，它的时限由 approval.ts 的
 * `approvalTimeoutMs` 统一管（超时会 abort，broker 收到 ask_cancel 后照样回
 * ask_result），在这一层再套一个短超时只会把稍慢的审批误判成通道故障。
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * GatewayLike 的 broker 实现：所有出站调用经 Unix socket 交给 broker，
 * 入站消息由 broker 按 chatId 路由过来。
 *
 * 与 FeishuGateway 的契约保持一致：**出站调用刻意不自我包含异常**，
 * 由 bridge.ts 侧统一兜底。
 */
export class BrokerGateway implements GatewayLike {
  #socket: net.Socket | undefined;
  #reader = new FrameReader();
  #pending = new Map<string, Pending>();
  #seq = 0;
  #bound: string | undefined;
  #messageHandler: ((msg: InboundMessage) => void) | undefined;
  /** 正在主动断开 —— 随之而来的 close 事件是预期内的，不该报警 */
  #closing = false;

  // strip-only 模式不支持构造函数参数属性，依赖写成显式字段
  readonly #log: LogFn;
  readonly #requestTimeoutMs: number;

  constructor(log: LogFn, requestTimeoutMs: number = REQUEST_TIMEOUT_MS) {
    this.#log = log;
    this.#requestTimeoutMs = requestTimeoutMs;
  }

  get boundChatId(): string | undefined {
    return this.#bound;
  }

  /**
   * 与 broker 的连接是否还活着。
   *
   * index.ts 拿 `gateway !== undefined` 当「运行中」，断线之后它仍为真 ——
   * `/feishu status` 必须能从这里看出连接已经掉了，否则用户只看到一堆
   * 「飞书流式发送失败」，不知道是 broker 挂了。
   */
  get connected(): boolean {
    return this.#socket !== undefined;
  }

  bind(chatId: string): void {
    // 绑定权在 broker 手里；本地只记录它告知的结果
    this.#bound = chatId;
  }

  unbind(): void {
    this.#bound = undefined;
    this.#post({ t: "unbind" });
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.#messageHandler = handler;
  }

  async connect(socketPath: string, label: string, cwd: string): Promise<void> {
    const socket = net.createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    socket.on("data", (chunk: Buffer) => {
      for (const f of this.#reader.push(chunk)) this.#onFrame(f as ServerFrame);
    });
    // 只清 #pending 不够：往后新发起的调用还是会摸到这个已经死掉的 socket，
    // #post 里的 write 静默无操作、#await 照样注册一个再也不会 settle 的 pending，
    // 请求就此永久挂起。必须把 #socket 也清空，让后续调用能借到这条报警线。
    //
    // 光清 #socket 也不够：#bound 留着的话本地状态就是假的 —— `/feishu status`
    // 会照样显示「运行中 · 绑定会话：oc_x」，而实际上每次 sendText 都在报错。
    // 用户只看到一堆「飞书流式发送失败」，没人告诉他 broker 掉了，所以还要报警。
    //
    // close/error 可能都触发（对端 RST 时两个都会来），必须幂等：置 undefined
    // 两次无副作用，#failAllPending 第二次面对空 Map 也是空操作，日志用 failed 去重。
    let failed = false;
    const fail = () => {
      const first = !failed;
      failed = true;
      this.#socket = undefined;
      this.#bound = undefined;
      // 主动 disconnect（停止桥接、会话切换）是预期内的，不该报 error 吓人
      if (first && !this.#closing) {
        this.#log(
          "与 broker 的连接已断开，飞书桥接已不可用。请重新拉起 broker 进程，再执行 /feishu start",
          "error",
        );
      }
      this.#failAllPending("broker 连接已断开");
    };
    socket.on("close", fail);
    socket.on("error", fail);
    this.#closing = false;
    this.#socket = socket;

    this.#post({ t: "hello", cwd, label });
    await this.#await("hello_ok");
  }

  async disconnect(): Promise<void> {
    this.#closing = true;
    const s = this.#socket;
    this.#socket = undefined;
    this.#bound = undefined;
    s?.destroy();
    this.#failAllPending("broker 连接已关闭");
  }

  async requestPairingCode(): Promise<string> {
    const id = this.#nextId();
    this.#post({ t: "pair_request", id });
    const f = (await this.#awaitId(id)) as { code: string };
    return f.code;
  }

  async sendText(markdown: string, to?: string): Promise<void> {
    const id = this.#nextId();
    this.#post({ t: "send_text", id, markdown, ...(to === undefined ? {} : { to }) });
    await this.#awaitId(id);
  }

  async streamTurn(run: (sink: AppendSink) => Promise<void>): Promise<void> {
    // 未绑定就安静地什么都不做，对齐 FeishuGateway.streamTurn 的
    // `if (!channel || !to) return`。
    //
    // Bridge.startTurn() 不看绑定状态，broker 档下未配对时每个终端回合都会走到
    // 这里。不拦的话：broker 对 stream_begin 回 err，而客户端要到 stream_end
    // 之后才登记 pending（两者共用同一个 id）—— 长回合里 err 先到、无人认领被
    // 丢弃，streamTurn 照常 resolve，bridge 以为流式成功而不补发全文，整回合内容
    // 静默丢失；顺带还会把整回合的 delta 推给 broker，在它那边刷出成百条 warning。
    if (this.#bound === undefined) return;
    const id = this.#nextId();
    this.#post({ t: "stream_begin", id });
    const sink: AppendSink = {
      append: async (chunk: string) => {
        this.#post({ t: "stream_chunk", id, text: chunk });
      },
    };
    try {
      await run(sink);
    } finally {
      this.#post({ t: "stream_end", id });
    }
    await this.#awaitId(id);
  }

  async downloadImage(fileKey: string): Promise<Buffer | undefined> {
    const id = this.#nextId();
    this.#post({ t: "download_image", id, fileKey });
    const f = (await this.#awaitId(id)) as { base64?: string };
    return f.base64 === undefined ? undefined : Buffer.from(f.base64, "base64");
  }

  /**
   * 已绑定会话的人类可读名称。查不到就返回 undefined —— 状态里退回只显示 id，
   * 绝不能让一次状态查询因为这个可有可无的信息而失败。
   *
   * 与本类其余出站方法不同：这里**自我兜底**，与 FeishuGateway.describeBoundChat
   * 的契约保持一致。其余方法（sendText/streamTurn/...）刻意不兜底、把异常交给
   * bridge.ts 统一处理，是因为它们的失败是业务结果；这个方法的失败只是「这次
   * 状态里少一个展示字段」，broker 连接已断（#socket 为空）时 #await 会立刻
   * reject，若不在这里兜住，`/feishu status` 会因为这个可有可无的信息直接炸掉。
   */
  async describeBoundChat(): Promise<string | undefined> {
    try {
      const id = this.#nextId();
      this.#post({ t: "describe_chat", id });
      const f = (await this.#awaitId(id)) as { label?: string };
      return f.label;
    } catch (err) {
      this.#log(`查询会话名称失败：${String(err)}`, "warning");
      return undefined;
    }
  }

  cardAsker: Asker = async (req, signal): Promise<Decision> => {
    const id = this.#nextId();
    if (signal.aborted) return { allow: false, reason: "已由其他通道处理" };
    const onAbort = () => this.#post({ t: "ask_cancel", id });
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      this.#post({ t: "ask", id, toolName: req.toolName, input: req.input });
      const f = (await this.#awaitApproval(id)) as { allow: boolean; reason: string; scope?: "turn" };
      return { allow: f.allow, reason: f.reason, ...(f.scope === "turn" ? { scope: "turn" as const } : {}) };
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  };

  #onFrame(f: ServerFrame): void {
    switch (f.t) {
      case "message":
        this.#messageHandler?.({
          chatId: f.chatId,
          senderId: f.senderId,
          text: f.text,
          imageKeys: f.imageKeys,
        });
        return;
      case "bound":
        this.#bound = f.chatId;
        return;
      case "unbound":
        this.#bound = undefined;
        return;
      case "hello_ok":
        this.#take("hello_ok")?.resolve(f);
        return;
      default: {
        const id = (f as { id?: string }).id;
        if (id === undefined) return;
        const p = this.#take(id);
        if (!p) return;
        if (f.t === "err") p.reject(new Error(f.message));
        else p.resolve(f);
      }
    }
  }

  /** 摘掉一个 pending 并停掉它的超时定时器。同一个 pending 只可能被兑现一次 */
  #take(key: string): Pending | undefined {
    const p = this.#pending.get(key);
    if (!p) return undefined;
    this.#pending.delete(key);
    if (p.timer !== undefined) clearTimeout(p.timer);
    return p;
  }

  #nextId(): string {
    this.#seq += 1;
    return String(this.#seq);
  }

  #post(frame: ClientFrame): void {
    try {
      this.#socket?.write(encodeFrame(frame));
    } catch (err) {
      this.#log(`向 broker 发送失败：${String(err)}`, "warning");
    }
  }

  /**
   * 未连接（尚未连过，或已断线/已 disconnect）时必须立刻 reject，不能注册一个
   * 借不到任何报警线、此后永远不会 settle 的 pending —— 那样的话，broker 崩溃
   * 之后同一个实例上继续发起的调用会把整个 agent 回合冻住，只能重启进程。
   */
  #register(key: string, timeoutMs: number | false): Promise<ServerFrame> {
    if (!this.#socket) return Promise.reject(new Error("broker 连接已断开，无法发起请求"));
    return new Promise<ServerFrame>((resolve, reject) => {
      const entry: Pending = { resolve, reject };
      this.#pending.set(key, entry);
      if (timeoutMs === false) return;
      // 断线能靠 socket 的 close/error 事件发现，「连着但不回帧」不能 —— 只有超时兜得住
      entry.timer = setTimeout(() => {
        if (this.#pending.get(key) !== entry) return;
        this.#pending.delete(key);
        reject(new Error(`等待 broker 响应超时（${timeoutMs}ms）`));
      }, timeoutMs);
    });
  }

  #await(key: string): Promise<ServerFrame> {
    return this.#register(key, this.#requestTimeoutMs);
  }

  #awaitId(id: string): Promise<ServerFrame> {
    return this.#register(id, this.#requestTimeoutMs);
  }

  /**
   * 审批专用：不设请求超时。人点按钮本来就可能比 REQUEST_TIMEOUT_MS 慢，
   * 它的时限由 approval.ts 的 approvalTimeoutMs 统一管。
   */
  #awaitApproval(id: string): Promise<ServerFrame> {
    return this.#register(id, false);
  }

  /** 断线时把所有在途请求一次性拒掉 —— 挂住的 promise 会把整个回合冻住 */
  #failAllPending(reason: string): void {
    for (const key of [...this.#pending.keys()]) {
      this.#take(key)?.reject(new Error(reason));
    }
  }
}
