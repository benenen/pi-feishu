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
}

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

  readonly #log: LogFn;

  constructor(log: LogFn) {
    this.#log = log;
  }

  get boundChatId(): string | undefined {
    return this.#bound;
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
    const fail = () => this.#failAllPending("broker 连接已断开");
    socket.on("close", fail);
    socket.on("error", fail);
    this.#socket = socket;

    this.#post({ t: "hello", cwd, label });
    await this.#await("hello_ok");
  }

  async disconnect(): Promise<void> {
    const s = this.#socket;
    this.#socket = undefined;
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

  async describeBoundChat(): Promise<string | undefined> {
    const id = this.#nextId();
    this.#post({ t: "describe_chat", id });
    const f = (await this.#awaitId(id)) as { label?: string };
    return f.label;
  }

  cardAsker: Asker = async (req, signal): Promise<Decision> => {
    const id = this.#nextId();
    if (signal.aborted) return { allow: false, reason: "已由其他通道处理" };
    const onAbort = () => this.#post({ t: "ask_cancel", id });
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      this.#post({ t: "ask", id, toolName: req.toolName, input: req.input });
      const f = (await this.#awaitId(id)) as { allow: boolean; reason: string; scope?: "turn" };
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
        this.#pending.get("hello_ok")?.resolve(f);
        this.#pending.delete("hello_ok");
        return;
      default: {
        const id = (f as { id?: string }).id;
        if (id === undefined) return;
        const p = this.#pending.get(id);
        if (!p) return;
        this.#pending.delete(id);
        if (f.t === "err") p.reject(new Error(f.message));
        else p.resolve(f);
      }
    }
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

  #await(key: string): Promise<ServerFrame> {
    return new Promise<ServerFrame>((resolve, reject) => {
      this.#pending.set(key, { resolve, reject });
    });
  }

  #awaitId(id: string): Promise<ServerFrame> {
    return this.#await(id);
  }

  /** 断线时把所有在途请求一次性拒掉 —— 挂住的 promise 会把整个回合冻住 */
  #failAllPending(reason: string): void {
    for (const [, p] of this.#pending) p.reject(new Error(reason));
    this.#pending.clear();
  }
}
