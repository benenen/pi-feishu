/**
 * 配对码的字母表。手机上输入，所以剔除易混字符：
 * 0/O、1/I/l 在多数字体下几乎不可分辨，一次输错就得重来。
 */
export const PAIRING_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** 码长。31^8 ≈ 8.5e11，配合时效与一次性足够挡住猜测 */
const CODE_LENGTH = 8;

export interface PairingOptions {
  now: () => number;
  /** 返回 [0, n) 的整数。默认用 crypto，可注入以便测试 */
  randomInt: (n: number) => number;
  ttlMs: number;
}

/**
 * 「先握手再绑定」的配对码。
 *
 * 没有它的话，未绑定状态下任意一条入站消息都会绑定该会话 —— 谁先说话谁就抢到
 * 这个 pi 会话的指令权。配对码把它变成一次显式握手：码只在终端显示，
 * 拿得到终端的人才能完成绑定。
 *
 * 三条性质缺一不可：
 * - **一次性**：用掉即失效，防止同一个码被重放到第二个会话
 * - **有时效**：终端上残留的旧码不该永远可用
 * - **重新签发即作废旧码**：否则 /feishu unbind 之后旧码仍能绑
 */
export class Pairing {
  #code: string | undefined;
  #expiresAt = 0;

  // strip-only 模式不支持构造函数参数属性，依赖写成显式字段
  readonly #now: () => number;
  readonly #randomInt: (n: number) => number;
  readonly #ttlMs: number;

  constructor(opts: PairingOptions) {
    this.#now = opts.now;
    this.#randomInt = opts.randomInt;
    this.#ttlMs = opts.ttlMs;
  }

  /** 是否正在等待配对（已签发且未过期） */
  get pending(): boolean {
    if (this.#code === undefined) return false;
    if (this.#now() > this.#expiresAt) {
      this.#code = undefined;
      return false;
    }
    return true;
  }

  get expiresAt(): number {
    return this.#expiresAt;
  }

  /** 签发一个新码，同时作废旧码 */
  issue(): string {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i += 1) {
      code += PAIRING_ALPHABET[this.#randomInt(PAIRING_ALPHABET.length)];
    }
    this.#code = code;
    this.#expiresAt = this.#now() + this.#ttlMs;
    return code;
  }

  cancel(): void {
    this.#code = undefined;
  }

  /**
   * 校验一条入站文本是否就是当前配对码。匹配成功则消耗掉该码。
   * 接受裸码和 `/feishu pair <码>` 两种写法。
   */
  match(text: string): boolean {
    if (!this.pending) return false;

    const trimmed = text.trim();
    const bare = /^\/feishu\s+pair\s+(\S+)$/i.exec(trimmed);
    const candidate = (bare?.[1] ?? trimmed).toUpperCase();

    if (candidate !== this.#code) return false;
    this.#code = undefined; // 一次性
    return true;
  }
}

/** 默认实现：真实时钟 + crypto 随机源 */
export function createPairing(ttlMs: number, randomInt: (n: number) => number): Pairing {
  return new Pairing({ now: () => Date.now(), randomInt, ttlMs });
}
