import { StringDecoder } from "node:string_decoder";

/** 单行上限。超过即丢弃该行 —— 对端异常时不能把 broker 的内存撑爆 */
const MAX_LINE_BYTES = 1_000_000;

export type ClientFrame =
  | { t: "hello"; cwd: string; label: string }
  | { t: "pair_request"; id: string }
  | { t: "unbind" }
  | { t: "send_text"; id: string; markdown: string; to?: string }
  | { t: "stream_begin"; id: string }
  | { t: "stream_chunk"; id: string; text: string }
  | { t: "stream_end"; id: string }
  | { t: "ask"; id: string; toolName: string; input: Record<string, unknown> }
  | { t: "ask_cancel"; id: string }
  | { t: "react"; messageId: string; emoji: string }
  | { t: "download_image"; id: string; fileKey: string }
  | { t: "describe_chat"; id: string };

export type ServerFrame =
  | { t: "hello_ok" }
  | { t: "pair_code"; id: string; code: string; expiresAt: number }
  | { t: "bound"; chatId: string }
  | { t: "unbound" }
  | { t: "message"; messageId: string; chatId: string; senderId: string; text: string; imageKeys: string[] }
  | { t: "ask_result"; id: string; allow: boolean; reason: string; scope?: "turn" }
  | { t: "ok"; id: string }
  | { t: "err"; id: string; message: string }
  | { t: "image"; id: string; base64?: string }
  | { t: "chat_desc"; id: string; label?: string };

export type Frame = ClientFrame | ServerFrame;

export function encodeFrame(frame: Frame): string {
  // JSON.stringify 会把内容里的换行转义成 \n 两个字符，行边界因此是安全的
  return `${JSON.stringify(frame)}\n`;
}

/**
 * 把字节流切成帧。
 *
 * 用 StringDecoder 而不是 chunk.toString()：一个多字节 UTF-8 字符可能横跨两个
 * chunk，逐块 toString 会在切口处产生替换字符，内容静默损坏。
 */
export class FrameReader {
  #decoder: StringDecoder;
  #buf: string;
  /** 当前行已超长，丢弃直到下一个换行 */
  #skipping: boolean;

  constructor() {
    this.#decoder = new StringDecoder("utf8");
    this.#buf = "";
    this.#skipping = false;
  }

  push(chunk: Buffer): Frame[] {
    this.#buf += this.#decoder.write(chunk);
    const out: Frame[] = [];

    for (;;) {
      const nl = this.#buf.indexOf("\n");
      if (nl === -1) break;
      const line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);

      if (this.#skipping) {
        this.#skipping = false;
        continue;
      }
      if (line === "") continue;
      try {
        out.push(JSON.parse(line) as Frame);
      } catch {
        // 坏行直接丢，不能因为对端发了脏数据就断整条连接
      }
    }

    if (this.#buf.length > MAX_LINE_BYTES) {
      this.#buf = "";
      this.#skipping = true;
    }
    return out;
  }
}
