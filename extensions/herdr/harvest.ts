import { open } from "node:fs/promises";
import { readAgent, type ReadOptions } from "./agents.ts";
import { err, ok, type HerdrAgent, type HerdrTarget, type Result } from "./types.ts";
import type { HerdrCli } from "./cli.ts";

/** 结果正文上限。飞书卡片塞得下这个量级，再长就只是把面板刷屏搬进聊天 */
export const RESULT_LIMIT = 6_000;
/** 只读会话文件尾部这么多字节。pi 的会话能长到几十 MB，全文读进来纯属浪费 */
const SESSION_TAIL_BYTES = 512 * 1024;

export interface Harvested {
  text: string;
  /**
   * 正文从哪里来：
   *   session —— 从 pi 的会话文件里抽的最后一条 assistant 回复，干净
   *   pane    —— 面板输出兜底，夹着 TUI 边框和页脚
   */
  source: "session" | "pane";
}

/**
 * 从 pi 的会话 JSONL 里抽**最后一条有正文的 assistant 回复**。
 *
 * 为什么值得为它绕这一下：面板输出（`agent read`）是渲染后的 TUI 文本，
 * 混着启动横幅、分隔线和状态页脚，直接丢进飞书很脏。而 pi 把每条消息都
 * 追加进了 JSONL，最后一行的 `message.role === "assistant"` 就是答案本身。
 *
 * 纯函数、从尾部往前扫：文件被截过尾巴、或中间有半行，都不影响结论。
 * 认不出任何一条就返回 undefined，由调用方退回面板输出。
 */
export function extractPiAnswer(jsonl: string): string | undefined {
  const lines = jsonl.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (e.type !== "message") continue;
    const message = e.message as Record<string, unknown> | undefined;
    if (message === undefined || message.role !== "assistant") continue;
    const text = textOf(message.content);
    if (text !== undefined && text.trim() !== "") return text;
  }
  return undefined;
}

function textOf(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const part of content) {
    if (part === null || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (p.type === "text" && typeof p.text === "string") parts.push(p.text);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/** 尾部截断。保留结尾 —— 结论在最后，开头才是可以丢的部分 */
export function tailTrim(text: string, limit: number = RESULT_LIMIT): string {
  const points = Array.from(text);
  if (points.length <= limit) return text;
  return `…（前面省略 ${points.length - limit} 字）\n${points.slice(points.length - limit).join("")}`;
}

export type ReadTail = (path: string, bytes: number) => Promise<string>;

export async function defaultReadTail(path: string, bytes: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    const start = Math.max(0, stat.size - bytes);
    const length = stat.size - start;
    const buf = Buffer.alloc(Number(length));
    await handle.read(buf, 0, Number(length), start);
    return buf.toString("utf8");
  } finally {
    await handle.close();
  }
}

export interface HarvestOptions extends ReadOptions {
  limit?: number;
  readTail?: ReadTail;
}

/**
 * 取一个 agent 的「结果」。
 *
 * pi agent 有会话文件就直接抽最后一条 assistant 回复；抽不到（claude/codex、
 * 或者会话还没落盘）就退回面板输出。两条路都拿不到内容时返回空串 ——
 * 调用方据此说「完成了但没读到内容」，而不是编一段。
 */
export async function harvestResult(
  cli: HerdrCli,
  target: HerdrTarget,
  agent: HerdrAgent | undefined,
  options: HarvestOptions = {},
): Promise<Result<Harvested>> {
  const limit = options.limit ?? RESULT_LIMIT;
  const readTail = options.readTail ?? defaultReadTail;

  if (agent?.sessionPath !== undefined) {
    try {
      const raw = await readTail(agent.sessionPath, SESSION_TAIL_BYTES);
      const answer = extractPiAnswer(raw);
      if (answer !== undefined) return ok({ text: tailTrim(answer, limit), source: "session" });
    } catch {
      // 会话文件读不到（权限、已删）就退回面板，不能让取结果整个失败
    }
  }

  const read = await readAgent(cli, target, options);
  if (!read.ok) {
    // 面板也读不到时，只有「agent 压根不在」才算错误；其余情况不如回空串
    return read.error.code === "NOT_FOUND"
      ? read
      : err(read.error.code, read.error.message, read.error.details);
  }
  return ok({ text: tailTrim(read.data.trimEnd(), limit), source: "pane" });
}
