import net from "node:net";
import fs from "node:fs";
import { randomInt, randomUUID } from "node:crypto";
import { encodeFrame, FrameReader, type ClientFrame, type ServerFrame } from "./protocol.ts";
import { SessionRegistry } from "./registry.ts";
import { TurnStream, type AppendSink } from "../turn-stream.ts";
import type { ApprovalRequest, Decision } from "../approval.ts";
import type { LogFn } from "../log.ts";
import type { InboundMessage } from "../types.ts";

export type { InboundMessage };

/** broker 需要的飞书能力。真实现在 channel.ts，测试注入假实现 */
export interface BrokerChannelLike {
  sendText(chatId: string, markdown: string): Promise<void>;
  streamTo(chatId: string, run: (sink: AppendSink) => Promise<void>): Promise<void>;
  askCard(chatId: string, req: ApprovalRequest, signal: AbortSignal): Promise<Decision>;
  downloadImage(fileKey: string): Promise<Buffer | undefined>;
  describeChat(chatId: string): Promise<string | undefined>;
}

export interface BrokerServerOptions {
  channel: BrokerChannelLike;
  pairingTtlMs: number;
  log: LogFn;
}

interface Conn {
  id: string;
  socket: net.Socket;
  reader: FrameReader;
  streams: Map<string, { stream: TurnStream; done: Promise<void> }>;
  asks: Map<string, AbortController>;
}

export class BrokerServer {
  #server: net.Server | undefined;
  #conns = new Map<string, Conn>();
  #registry: SessionRegistry;

  readonly #channel: BrokerChannelLike;
  readonly #log: LogFn;

  constructor(opts: BrokerServerOptions) {
    this.#channel = opts.channel;
    this.#log = opts.log;
    this.#registry = new SessionRegistry({
      now: () => Date.now(),
      randomInt,
      pairingTtlMs: opts.pairingTtlMs,
    });
  }

  get sessionCount(): number {
    return this.#conns.size;
  }

  async listen(socketPath: string): Promise<void> {
    // 上次非正常退出会留下 socket 文件，不清掉会 EADDRINUSE
    fs.rmSync(socketPath, { force: true });

    const server = net.createServer((socket) => this.#onConnection(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });
    // 鉴权全靠文件权限：同机其他用户不得连入
    fs.chmodSync(socketPath, 0o600);
    this.#server = server;
  }

  async close(): Promise<void> {
    for (const c of this.#conns.values()) c.socket.destroy();
    this.#conns.clear();
    const s = this.#server;
    this.#server = undefined;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  /** 飞书侧收到消息时调用 */
  deliver(msg: InboundMessage): void {
    const owner = this.#registry.byChat(msg.chatId);
    if (owner) {
      this.#send(owner.id, {
        t: "message",
        chatId: msg.chatId,
        senderId: msg.senderId,
        text: msg.text,
        imageKeys: msg.imageKeys,
      });
      return;
    }

    const paired = this.#registry.matchCode(msg.text);
    if (paired) {
      this.#registry.bind(paired.id, msg.chatId);
      // 绑定成功只通过 bound 帧通知会话本身，不在这里直接向飞书发确认文本：
      // 这条消息和会话随后自己发的内容会共用同一条出站通道（同一个 chatId），
      // 在真实 channel 里是时序竞争，在测试用的同步假通道里则是确定性地污染
      // 顺序——回执交给会话自己决定要不要发，broker 只管路由。
      this.#send(paired.id, { t: "bound", chatId: msg.chatId });
      return;
    }

    void this.#safe(() =>
      this.#channel.sendText(msg.chatId, "该对话尚未绑定 pi 会话，请发送终端上显示的配对码。"),
    );
  }

  #onConnection(socket: net.Socket): void {
    const id = randomUUID();
    const conn: Conn = { id, socket, reader: new FrameReader(), streams: new Map(), asks: new Map() };
    this.#conns.set(id, conn);

    socket.on("data", (chunk: Buffer) => {
      for (const f of conn.reader.push(chunk)) {
        void this.#safe(() => this.#handle(conn, f as ClientFrame));
      }
    });
    const drop = () => {
      for (const a of conn.asks.values()) a.abort();
      this.#registry.remove(id);
      this.#conns.delete(id);
    };
    socket.on("close", drop);
    socket.on("error", drop);
  }

  async #handle(conn: Conn, f: ClientFrame): Promise<void> {
    switch (f.t) {
      case "hello":
        this.#registry.add({ id: conn.id, label: f.label, cwd: f.cwd });
        this.#send(conn.id, { t: "hello_ok" });
        return;

      case "pair_request": {
        const code = this.#registry.issueCode(conn.id);
        this.#send(conn.id, { t: "pair_code", id: f.id, code, expiresAt: 0 });
        return;
      }

      case "unbind":
        this.#registry.unbind(conn.id);
        this.#send(conn.id, { t: "unbound" });
        return;

      case "send_text": {
        const chatId = f.to ?? this.#registry.boundChatOf(conn.id);
        if (chatId === undefined) return this.#send(conn.id, { t: "err", id: f.id, message: "未绑定会话" });
        await this.#channel.sendText(chatId, f.markdown);
        this.#send(conn.id, { t: "ok", id: f.id });
        return;
      }

      case "stream_begin": {
        const chatId = this.#registry.boundChatOf(conn.id);
        if (chatId === undefined) return this.#send(conn.id, { t: "err", id: f.id, message: "未绑定会话" });
        const stream = new TurnStream();
        // channel.stream 是拉模型，这里让它从 TurnStream 拉；
        // 会话推来的 chunk 往同一个 TurnStream 推 —— 现成的推拉适配器跨进程复用
        const done = this.#channel.streamTo(chatId, (sink) => stream.pump(sink));
        conn.streams.set(f.id, { stream, done });
        return;
      }

      case "stream_chunk":
        conn.streams.get(f.id)?.stream.push(f.text);
        return;

      case "stream_end": {
        const entry = conn.streams.get(f.id);
        conn.streams.delete(f.id);
        if (!entry) return this.#send(conn.id, { t: "ok", id: f.id });
        entry.stream.finish();
        try {
          await entry.done;
          this.#send(conn.id, { t: "ok", id: f.id });
        } catch (err) {
          this.#send(conn.id, { t: "err", id: f.id, message: String(err) });
        }
        return;
      }

      case "ask": {
        const chatId = this.#registry.boundChatOf(conn.id);
        if (chatId === undefined) {
          // fail-closed：拿不到会话就是拒绝，绝不放行
          this.#send(conn.id, { t: "ask_result", id: f.id, allow: false, reason: "未绑定会话" });
          return;
        }
        const ac = new AbortController();
        conn.asks.set(f.id, ac);
        try {
          const d = await this.#channel.askCard(chatId, { toolName: f.toolName, input: f.input }, ac.signal);
          this.#send(conn.id, {
            t: "ask_result",
            id: f.id,
            allow: d.allow,
            reason: d.reason,
            ...(d.scope === "turn" ? { scope: "turn" as const } : {}),
          });
        } catch (err) {
          this.#send(conn.id, { t: "ask_result", id: f.id, allow: false, reason: `审批通道异常：${String(err)}` });
        } finally {
          conn.asks.delete(f.id);
        }
        return;
      }

      case "ask_cancel":
        conn.asks.get(f.id)?.abort();
        conn.asks.delete(f.id);
        return;

      case "download_image": {
        const buf = await this.#channel.downloadImage(f.fileKey);
        this.#send(conn.id, { t: "image", id: f.id, base64: buf?.toString("base64") });
        return;
      }

      case "describe_chat": {
        const chatId = this.#registry.boundChatOf(conn.id);
        const label = chatId === undefined ? undefined : await this.#channel.describeChat(chatId);
        this.#send(conn.id, { t: "chat_desc", id: f.id, label });
        return;
      }

      default:
        // protocol.ts 的 FrameReader 只做 JSON.parse + 类型断言，不做运行时校验，
        // 所以形状不对的合法 JSON（`42`、`{"t":"不存在的类型"}`）也会被当成
        // ClientFrame 传进来。这里必须兜底：记日志忽略，绝不能让畸形帧打死 broker。
        this.#log(`收到无法识别的帧，已忽略：${JSON.stringify(f)}`, "warning");
        return;
    }
  }

  #send(connId: string, frame: ServerFrame): void {
    const c = this.#conns.get(connId);
    if (!c) return;
    try {
      c.socket.write(encodeFrame(frame));
    } catch {
      // 对端已断开，忽略；close 事件会清理注册表
    }
  }

  /** 任何异步失败只记日志，绝不让它冒成 unhandledRejection 把 broker 打死 */
  async #safe(work: () => Promise<unknown> | unknown): Promise<void> {
    try {
      await work();
    } catch (err) {
      this.#log(`broker 处理失败：${String(err)}`, "error");
    }
  }
}
