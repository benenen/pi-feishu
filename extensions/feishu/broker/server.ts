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
  /** 已经为哪些流 id 记过孤儿 chunk 的日志 —— 一个回合几百个 delta，不能每块一条 */
  orphanWarned: Set<string>;
}

/**
 * 孤儿流 id 的留痕上限。正常客户端最多产生个位数，超出说明对端在乱发；
 * 不设上限的话，一个失控的对端能靠不断换 id 把 broker 的内存撑大。
 */
const MAX_ORPHAN_WARNED = 64;

/** unix socket 连接要么立刻连上、要么立刻被拒（ECONNREFUSED/ENOENT），正常情况不会卡住 */
const PROBE_TIMEOUT_MS = 500;

/**
 * 探测 socketPath 是否有活着的进程在监听。
 *
 * 用于区分「上次崩溃残留的死文件」（该删）和「当前还活着的 broker 正占用」
 * （绝不能删）——不区分这两者，无条件 rmSync 会让第二个误启动的 broker 静默
 * 接管 socket，第一个仍存活、仍握着飞书长连接，一声不吭。
 *
 * true  —— 连上了，有活 broker 占着
 * false —— 连不上（ECONNREFUSED/ENOENT 等），是死文件
 * 抛错   —— 探测本身超时、状态不明；fail-closed：不确定就不删
 */
function probeAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(new Error(`探测 ${socketPath} 是否被占用超时，为安全起见拒绝启动`));
    }, PROBE_TIMEOUT_MS);
    sock.once("connect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(false);
    });
  });
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
    // 上次非正常退出会留下 socket 文件，不清掉会 EADDRINUSE —— 但无条件删
    // 不区分「死文件」和「活着的 broker 正占用」，必须先探活。
    if (fs.existsSync(socketPath) && (await probeAlive(socketPath))) {
      throw new Error(`该 socket 已被另一个 broker 占用：${socketPath}`);
    }
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
      // 被顶掉的会话必须被告知：静默置为未绑定的话，它本地的 #bound 还留着旧
      // chatId、status 照样说「已绑定」，而每次 sendText 都拿到「未绑定会话」，
      // 且再也收不到任何消息。
      const displaced = this.#registry.bind(paired.id, msg.chatId);
      if (displaced !== undefined) this.#send(displaced, { t: "unbound" });
      this.#send(paired.id, { t: "bound", chatId: msg.chatId });
      // 单会话版 index.ts 在绑定成功时会给飞书发确认，broker 版沿用同样的体验：
      // 用户输完配对码得有反馈，不能指望会话自己记得回一句。
      void this.#safe(() =>
        this.#channel.sendText(msg.chatId, `配对成功，本对话已绑定 pi 会话：${paired.label}`),
      );
      return;
    }

    void this.#safe(() =>
      this.#channel.sendText(msg.chatId, "该对话尚未绑定 pi 会话，请发送终端上显示的配对码。"),
    );
  }

  #onConnection(socket: net.Socket): void {
    const id = randomUUID();
    const conn: Conn = {
      id,
      socket,
      reader: new FrameReader(),
      streams: new Map(),
      asks: new Map(),
      orphanWarned: new Set(),
    };
    this.#conns.set(id, conn);

    socket.on("data", (chunk: Buffer) => {
      for (const f of conn.reader.push(chunk)) {
        void this.#dispatch(conn, f as ClientFrame);
      }
    });
    const drop = () => {
      for (const a of conn.asks.values()) a.abort();
      // 连接断开时 stream_end 永远不会再来了：
      // - 不调用 finish()，pump() 会永远卡在 await new Promise(...)，飞书那条流式
      //   消息永远处于未完成状态；
      // - 不给 entry.done 挂 catch，它之后一旦 reject（真实网络里完全会发生，比如
      //   飞书流式调用中途抖动）就是 unhandledRejection，直接打死整个 broker 进程。
      // 所以两件事都要做：让 pump 收尾，并兜住 done 的 rejection。
      for (const entry of conn.streams.values()) {
        entry.stream.finish();
        entry.done.catch((err) => {
          this.#log(`连接断开后流式收尾失败（已忽略）：${String(err)}`, "error");
        });
      }
      conn.streams.clear();
      this.#registry.remove(id);
      this.#conns.delete(id);
    };
    socket.on("close", drop);
    socket.on("error", drop);
  }

  /**
   * 帧派发的唯一入口。**带 id 的请求必须收到 ok / err 之一**。
   *
   * 只记日志不回帧的话，客户端那个 pending 永远不会 settle：`send_text` 撞上
   * 飞书 429 会让 Bridge.endTurn() 一直等下去，pi 的 agent_end 处理器永不返回，
   * 整个 agent 回合冻住；`pair_request` 撞上 registry 的「未知会话」则会让
   * startInner 永不返回，扩展永远卡在「飞书桥接正在启动中」。
   *
   * 不带 id 的帧（hello / unbind / ask_cancel）没有请求-响应语义，照旧只记日志。
   */
  async #dispatch(conn: Conn, f: ClientFrame): Promise<void> {
    try {
      await this.#handle(conn, f);
    } catch (err) {
      this.#log(`broker 处理失败：${String(err)}`, "error");
      const id = (f as { id?: unknown }).id;
      if (typeof id === "string") this.#send(conn.id, { t: "err", id, message: String(err) });
    }
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
        const bound = this.#registry.boundChatOf(conn.id);
        // to 只能是本会话自己绑的那个 chat。不校验的话 send_text 就是一个不受
        // 绑定关系约束的跨会话写入原语：任何连上 socket 的进程都能以机器人身份
        // 往别人绑定的对话里发消息，连「自己是否绑定过」都不要求。
        // 被 socket 0600 挡着，但它是 listen()→chmod 那个 TOCTOU 窗口唯一有
        // 杀伤力的落点；而正常用法里 to 的取值本来就恒等于已绑的 chat。
        if (f.to !== undefined && f.to !== bound) {
          return this.#send(conn.id, {
            t: "err",
            id: f.id,
            message: "收件会话不是本会话绑定的对话",
          });
        }
        const chatId = f.to ?? bound;
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
        // 立刻标记「这个 rejection 有人管」。streamTo 的失败（限流 / 卡片元素超限 /
        // 网络抖动）几十毫秒就能到，而 stream_end 要等整个回合跑完（数秒到数分钟）
        // 才发出 —— 那段窗口里 done 没有任何 handler，Node 会在当前事件循环末尾判定
        // unhandledRejection，bin/broker.ts 的处理器直接 process.exit(1)：一次普通的
        // 流式失败打死整个 broker，挂在它上面的所有会话同时失联。
        // 这只是「标记已处理」，不是吞掉结果 —— 同一个 promise 可以挂多个 handler，
        // 下面 stream_end 里的 `await entry.done` 照样拿得到这个 rejection。
        done.catch(() => {});
        conn.streams.set(f.id, { stream, done });
        return;
      }

      case "stream_chunk": {
        const entry = conn.streams.get(f.id);
        if (!entry) {
          // 正常客户端不会走到这：要么 id 打错了，要么 stream_end/断线清理已经跑过。
          // 协议层没有其他排查手段，至少留一行日志 —— 但只留一行：一个回合是几百个
          // delta，每块一条会把日志冲得没法看（实测 200 个 delta → 201 条 warning）。
          this.#warnOrphan(conn, "stream_chunk", f.id);
          return;
        }
        entry.stream.push(f.text);
        return;
      }

      case "stream_end": {
        const entry = conn.streams.get(f.id);
        conn.streams.delete(f.id);
        if (!entry) {
          // 静默回 ok 会让客户端误以为发送成功；先记一条 warning 留痕，再照旧回 ok
          // 保持协议对客户端的可预期性（stream_end 总有响应）。
          this.#log(`收到未知流的 stream_end（id=${f.id}），已丢弃`, "warning");
          return this.#send(conn.id, { t: "ok", id: f.id });
        }
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

  /** 同一个流 id 只留一次痕。超过上限就不再记，避免对端靠换 id 把内存撑大 */
  #warnOrphan(conn: Conn, kind: string, streamId: string): void {
    if (conn.orphanWarned.has(streamId)) return;
    if (conn.orphanWarned.size >= MAX_ORPHAN_WARNED) return;
    conn.orphanWarned.add(streamId);
    this.#log(`收到未知流的 ${kind}（id=${streamId}），已丢弃`, "warning");
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
