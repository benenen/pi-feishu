export interface EnsureDeps {
  /** socket 能否连上 —— 能连上就说明确实有 broker 在服务 */
  probe: () => Promise<boolean>;
  /** 拉起 broker 进程（detached），失败时抛错 */
  spawn: () => { pid?: number };
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  timeoutMs: number;
  pollMs: number;
}

export type EnsureResult = "already" | "started" | "failed";

/**
 * 确保 broker 在服务，不在就拉起来。
 *
 * 判活一律用 socket 探活而不是 pid 文件：pid 会被复用，而「能连上」才是
 * 调用方真正关心的那件事。这也与 broker 自己 `listen()` 里防重复启动用的是同一招。
 *
 * 并发是常态 —— 多个 pi 会话可能同时启动、同时发现连不上、同时去拉。这没关系：
 * broker 的 `listen()` 会探活，后到的那个发现 socket 已被占用就自己退出。所以本函数
 * 在每个失败路径上都会**再探一次**：只要最终有 broker 在服务，就算成功，
 * 不管赢的是不是自己拉起的那个。
 */
export async function ensureBroker(
  deps: EnsureDeps,
  log: (msg: string) => void,
): Promise<EnsureResult> {
  if (await deps.probe()) return "already";

  try {
    const child = deps.spawn();
    log(`broker 未在运行，已自动拉起（pid=${child.pid ?? "?"}）`);
  } catch (err) {
    // 自己没拉起来，但可能是并发的另一个会话拉起来了 —— 探一次再下结论
    if (await deps.probe()) {
      log("broker 已由其他 pi 会话拉起");
      return "started";
    }
    log(`拉起 broker 失败：${String(err)}`);
    return "failed";
  }

  const deadline = deps.now() + deps.timeoutMs;
  while (deps.now() < deadline) {
    if (await deps.probe()) return "started";
    await deps.sleep(deps.pollMs);
  }

  // 超时后再探一次：轮询间隙里对方可能刚刚就绪
  if (await deps.probe()) return "started";
  log(`broker 拉起后 ${Math.round(deps.timeoutMs / 1000)}s 内仍未就绪`);
  return "failed";
}
