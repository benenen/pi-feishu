import { Pairing } from "../pairing.ts";

export interface SessionHandle {
  id: string;
  label: string;
  cwd: string;
}

export interface RegistryOptions {
  now: () => number;
  randomInt: (n: number) => number;
  pairingTtlMs: number;
}

interface Entry {
  handle: SessionHandle;
  pairing: Pairing;
  chatId?: string;
}

/**
 * chatId ↔ 会话 的双向路由表，外加每个会话自己的待配对码。
 *
 * 两条不变量：
 * - 一个 chatId 至多映射到一个会话（后绑顶掉先绑），否则一条消息会喂给两个 agent
 * - 一个会话换绑时必须清掉旧 chatId 的路由，否则旧对话的消息会继续投给它
 */
export class SessionRegistry {
  #entries = new Map<string, Entry>();
  #byChat = new Map<string, string>();

  // strip-only 模式不支持构造函数参数属性，依赖写成显式字段
  readonly #opts: RegistryOptions;

  constructor(opts: RegistryOptions) {
    this.#opts = opts;
  }

  add(handle: SessionHandle): void {
    this.#entries.set(handle.id, {
      handle,
      pairing: new Pairing({
        now: this.#opts.now,
        randomInt: this.#opts.randomInt,
        ttlMs: this.#opts.pairingTtlMs,
      }),
    });
  }

  remove(id: string): void {
    const e = this.#entries.get(id);
    if (!e) return;
    if (e.chatId !== undefined) this.#byChat.delete(e.chatId);
    e.pairing.cancel();
    this.#entries.delete(id);
  }

  byId(id: string): SessionHandle | undefined {
    return this.#entries.get(id)?.handle;
  }

  byChat(chatId: string): SessionHandle | undefined {
    const id = this.#byChat.get(chatId);
    return id === undefined ? undefined : this.#entries.get(id)?.handle;
  }

  boundChatOf(id: string): string | undefined {
    return this.#entries.get(id)?.chatId;
  }

  issueCode(id: string): string {
    const e = this.#entries.get(id);
    if (!e) throw new Error(`未知会话 ${id}`);
    return e.pairing.issue();
  }

  /** 逐个会话试；命中即消耗掉该码 */
  matchCode(text: string): SessionHandle | undefined {
    for (const e of this.#entries.values()) {
      if (e.pairing.match(text)) return e.handle;
    }
    return undefined;
  }

  bind(id: string, chatId: string): void {
    const e = this.#entries.get(id);
    if (!e) return;

    // 该 chatId 原先属于别的会话 —— 把那个会话置为未绑定
    const prevOwner = this.#byChat.get(chatId);
    if (prevOwner !== undefined && prevOwner !== id) {
      const prev = this.#entries.get(prevOwner);
      if (prev) prev.chatId = undefined;
    }
    // 本会话原先绑着别的 chat —— 清掉旧路由
    if (e.chatId !== undefined && e.chatId !== chatId) this.#byChat.delete(e.chatId);

    e.chatId = chatId;
    this.#byChat.set(chatId, id);
  }

  unbind(id: string): void {
    const e = this.#entries.get(id);
    if (!e || e.chatId === undefined) return;
    this.#byChat.delete(e.chatId);
    e.chatId = undefined;
  }

  list(): Array<{ id: string; label: string; cwd: string; chatId?: string }> {
    return [...this.#entries.values()].map((e) => ({
      id: e.handle.id,
      label: e.handle.label,
      cwd: e.handle.cwd,
      chatId: e.chatId,
    }));
  }
}
