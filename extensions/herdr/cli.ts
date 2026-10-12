import { spawn } from "node:child_process";
import { delimiter, join } from "node:path";
import { existsSync } from "node:fs";
import { err, ok, type HerdrErrorCode, type Result } from "./types.ts";

/**
 * 子进程的一次运行结果。`spawnError` 只在**根本没能执行**时出现
 * （ENOENT / EACCES），此时 `code` 是 null —— 它和「跑完了但退出码非 0」
 * 是两回事，前者要报 HERDR_UNAVAILABLE，后者要看 herdr 的 JSON 信封。
 */
export interface SpawnOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: NodeJS.ErrnoException;
  /** 到点被杀。`run` 靠它翻成 TIMEOUT，而不是去猜退出码 */
  timedOut?: boolean;
  /** 调用方 abort 被杀。翻成 CANCELLED */
  aborted?: boolean;
}

export interface SpawnOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  env: NodeJS.ProcessEnv;
  cwd?: string;
}

/** 可注入的进程启动器。生产用 `defaultSpawn`，测试直接给假函数 */
export type SpawnFn = (bin: string, args: string[], opts: SpawnOptions) => Promise<SpawnOutcome>;

export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** stdout 不是 JSON 但退出码 0 时，把原始文本当成功数据（`--version`、`agent read`） */
  textOk?: boolean;
  cwd?: string;
}

export interface HerdrCli {
  readonly bin: string;
  run<T = unknown>(args: string[], opts?: RunOptions): Promise<Result<T>>;
}

export interface HerdrCliOptions {
  bin: string;
  spawn: SpawnFn;
  env?: NodeJS.ProcessEnv;
  defaultTimeoutMs?: number;
  /**
   * 拼在每条命令最前面的全局参数，比如 `["--session","work"]`。
   * 命名 session 之间用同一套 `agent`/`pane` 子命令，只有全局前缀区分它们。
   */
  globalArgs?: string[];
}

/** herdr 的默认单次调用超时。长任务用 `agent prompt --wait` 时由调用方显式放宽 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * `herdr` 二进制的位置。
 *
 * 优先级：`HERDR_BIN` 环境变量 → `PATH` 里第一个存在的 `herdr` → 裸名字。
 * 一路找不到也返回裸名字：让 spawn 报 ENOENT，我们再翻成
 * `HERDR_UNAVAILABLE`，比在这里抛异常更好定位（提示里带上 HERDR_BIN）。
 */
export function resolveHerdrBin(
  env: Record<string, string | undefined> = process.env,
  exists: (p: string) => boolean = existsSync,
): string {
  const override = env.HERDR_BIN;
  if (override !== undefined && override !== "") return override;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, "herdr");
    try {
      if (exists(candidate)) return candidate;
    } catch {
      /* 读不了的目录跳过 */
    }
  }
  return "herdr";
}

/** herdr 原始错误码 → 归一化错误码。认不出的一律 VALIDATION_ERROR，原始码留在 details */
export function mapErrorCode(raw: string): HerdrErrorCode {
  const c = raw.toLowerCase();
  if (c === "agent_start_failed") return "AGENT_START_FAILED";
  if (c === "agent_not_ready") return "AGENT_NOT_READY";
  if (c === "agent_prompt_stalled") return "PROMPT_STALLED";
  if (c === "agent_blocked") return "AGENT_BLOCKED";
  if (c.includes("not_found") || c === "no_such_agent" || c === "no_such_pane") return "NOT_FOUND";
  if (c.includes("gone")) return "NOT_FOUND";
  if (c.includes("timeout") || c.includes("timed_out")) return "TIMEOUT";
  if (c.includes("cancel") || c.includes("abort")) return "CANCELLED";
  return "VALIDATION_ERROR";
}

/** 解析 stdout 里最后一个 JSON 对象。herdr 会在 JSON 前后夹非 JSON 行 */
export function parseLastJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    /* 落到逐行扫描 */
  }
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim() !== "");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* 继续往前找 */
    }
  }
  return null;
}

/**
 * 把一个 `herdr <args>` 的调用结果翻成 `Result<T>`。
 * **绝不抛异常**：每一条失败路径都落到 `{ ok: false, error }`。
 *
 * 信封是 `{ id, result }` 或 `{ id, error: { code, message } }`。退出码非 0 时
 * herdr 0.9 把错误信封写在 **stderr** 上（stdout 为空），所以两边都要看。
 */
export function createHerdrCli(options: HerdrCliOptions): HerdrCli {
  const env = options.env ?? process.env;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const globalArgs = options.globalArgs ?? [];

  return {
    bin: options.bin,
    async run<T>(args: string[], opts: RunOptions = {}): Promise<Result<T>> {
      const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs;
      const full = globalArgs.length > 0 ? [...globalArgs, ...args] : args;
      if (opts.signal?.aborted === true) {
        return err("CANCELLED", `herdr ${args[0] ?? ""} 调用已被取消`);
      }
      let outcome: SpawnOutcome;
      try {
        outcome = await options.spawn(options.bin, full, {
          timeoutMs,
          signal: opts.signal,
          env,
          cwd: opts.cwd,
        });
      } catch (e) {
        return err("HERDR_UNAVAILABLE", `无法启动 herdr：${message(e)}`);
      }

      // 超时/取消优先于一切：此时 stdout 是半截的，解析它只会得到误导性的错误
      if (outcome.timedOut === true) {
        return err("TIMEOUT", `herdr ${full.join(" ")} 超过 ${timeoutMs}ms 未返回`, {
          stdout: outcome.stdout,
        });
      }
      if (outcome.aborted === true) {
        return err("CANCELLED", `herdr ${full.join(" ")} 调用已被取消`);
      }

      if (outcome.spawnError !== undefined) {
        const code = outcome.spawnError.code;
        return code === "ENOENT"
          ? err(
              "HERDR_UNAVAILABLE",
              `找不到 herdr（${options.bin}）。装好 herdr 并用 HERDR_BIN 指定路径，或把 herdr 放进 PATH`,
            )
          : err("HERDR_UNAVAILABLE", `执行 herdr 失败：${message(outcome.spawnError)}`);
      }

      let parsed = parseLastJson(outcome.stdout);
      if (parsed === null && outcome.code !== 0) {
        const alt = parseLastJson(outcome.stderr);
        if (alt !== null && typeof alt === "object" && "error" in (alt as object)) parsed = alt;
      }

      if (parsed === null) {
        // `pane send-keys` 之类成功时输出为空
        if (outcome.code === 0 && outcome.stdout.trim() === "" && outcome.stderr.trim() === "") {
          return ok({} as T);
        }
        if (opts.textOk === true && outcome.code === 0 && outcome.stdout.trim() !== "") {
          return ok(outcome.stdout as unknown as T);
        }
        const firstErr = outcome.stderr.split(/\r?\n/).find((l) => l.trim() !== "");
        return err(
          "VALIDATION_ERROR",
          firstErr !== undefined
            ? `herdr 报错：${firstErr.trim()}`
            : "herdr 的输出无法解析为 JSON",
          { exitCode: outcome.code, stdout: outcome.stdout, stderr: outcome.stderr },
        );
      }

      const envelope = parsed as {
        error?: { code?: unknown; message?: unknown };
        result?: unknown;
      };
      if (envelope.error !== undefined && envelope.error !== null) {
        const rawCode = String(envelope.error.code ?? "");
        return err(
          mapErrorCode(rawCode),
          String(envelope.error.message ?? "herdr 返回了错误"),
          { rawCode },
        );
      }
      return ok((envelope.result ?? parsed) as T);
    },
  };
}

function message(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * 生产用的进程启动器。
 *
 * `shell: false`：herdr 是原生二进制，argv 逐字传递，不经 shell 解析 ——
 * 不然 agent 名或 prompt 里的引号会被 shell 再次拆开。超时和 abort 都杀进程，
 * 并**总是** resolve（把结果与超时事实一起交回去），让上层决定怎么翻译。
 */
export const defaultSpawn: SpawnFn = (bin, args, opts) =>
  new Promise<SpawnOutcome>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { shell: false, env: opts.env, cwd: opts.cwd });
    } catch (e) {
      resolve({ code: null, stdout: "", stderr: "", spawnError: e as NodeJS.ErrnoException });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let aborted = opts.signal?.aborted === true;

    const finish = (outcome: SpawnOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (opts.signal !== undefined) opts.signal.removeEventListener("abort", onAbort);
      resolve({ ...outcome, ...(timedOut ? { timedOut: true } : {}), ...(aborted ? { aborted: true } : {}) });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* 进程可能已经退出 */
      }
    }, opts.timeoutMs);

    const onAbort = () => {
      aborted = true;
      try {
        child.kill();
      } catch {
        /* 同上 */
      }
    };
    if (opts.signal !== undefined) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (d: Buffer | string) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer | string) => {
      stderr += d.toString();
    });
    child.on("error", (e) => {
      finish({ code: null, stdout, stderr, spawnError: e as NodeJS.ErrnoException });
    });
    child.on("close", (code) => {
      finish({ code, stdout, stderr });
    });
  });
