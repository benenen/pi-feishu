import fs from "node:fs";
import path from "node:path";

export type ApprovalMode = "balanced" | "strict";

export interface Config {
  appId: string;
  appSecret: string;
  autoStart: boolean;
  dmAllowlist: string[];
  groupAllowlist: string[];
  /** 谁的卡片点击算数。飞书 SDK 不对 card.action.trigger 做任何白名单过滤 */
  approverAllowlist: string[];
  requireMention: boolean;
  approvalMode: ApprovalMode;
  approvalTimeoutMs: number;
  repoRoot: string;
}

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`pi-feishu 配置有 ${problems.length} 处问题：\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

export interface ConfigFile {
  /** 已解析的内容；文件不存在时为 undefined */
  value: unknown;
  /** 文件存在但解析失败时的说明；否则为 undefined */
  problem?: string;
}

export type FileReader = (file: string) => string | undefined;

const readFileOrUndefined: FileReader = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};

/**
 * 读一个配置文件。刻意把「文件不存在」和「文件存在但 JSON 有语法错」区分开 ——
 * 两者都静默跳过的话，用户改坏了配置只会看到一句莫名其妙的「缺少 appId」，
 * 或者更糟：白名单悄悄退回空数组而毫无提示。
 */
export function readConfigFile(file: string, read: FileReader = readFileOrUndefined): ConfigFile {
  const raw = read(file);
  if (raw === undefined) return { value: undefined };
  try {
    return { value: JSON.parse(raw) };
  } catch (err) {
    return { value: undefined, problem: `${file} 不是合法的 JSON：${String(err)}` };
  }
}

export interface LoadConfigArgs {
  /** 低优先级在前，后面的覆盖前面的。可以是已解析的值，也可以是 readConfigFile 的结果 */
  files: (unknown | ConfigFile)[];
  env: Record<string, string | undefined>;
  cwd: string;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function readStringArray(v: unknown, key: string, problems: string[]): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    problems.push(`${key} 必须是字符串数组`);
    return undefined;
  }
  return v as string[];
}

function readBoolean(v: unknown, key: string, fallback: boolean, problems: string[]): boolean {
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") {
    problems.push(`${key} 必须是布尔值`);
    return fallback;
  }
  return v;
}

export function loadConfig({ files, env, cwd }: LoadConfigArgs): Config {
  const merged: Record<string, unknown> = {};
  const problems: string[] = [];

  for (const f of files) {
    // readConfigFile 的结果带 problem 字段；直接传进来的普通对象没有
    if (f !== null && typeof f === "object" && "value" in f) {
      const entry = f as ConfigFile;
      if (entry.problem !== undefined) problems.push(entry.problem);
      Object.assign(merged, asRecord(entry.value));
      continue;
    }
    Object.assign(merged, asRecord(f));
  }

  const appId = env.FEISHU_APP_ID ?? (typeof merged.appId === "string" ? merged.appId : undefined);
  if (!appId) problems.push("缺少 appId（配置文件 appId 或环境变量 FEISHU_APP_ID）");

  const appSecret =
    env.FEISHU_APP_SECRET ?? (typeof merged.appSecret === "string" ? merged.appSecret : undefined);
  if (!appSecret) problems.push("缺少 appSecret（配置文件 appSecret 或环境变量 FEISHU_APP_SECRET）");

  const autoStart = readBoolean(merged.autoStart, "autoStart", false, problems);
  const requireMention = readBoolean(merged.requireMention, "requireMention", true, problems);

  const dmAllowlist = readStringArray(merged.dmAllowlist, "dmAllowlist", problems) ?? [];
  const groupAllowlist = readStringArray(merged.groupAllowlist, "groupAllowlist", problems) ?? [];
  if (dmAllowlist.length === 0 && groupAllowlist.length === 0) {
    problems.push("dmAllowlist 和 groupAllowlist 不能同时为空，否则没人能触达机器人");
  }

  // 卡片点击不经飞书 SDK 的策略管道，必须自己鉴权。默认沿用 dmAllowlist；
  // 只配了 groupAllowlist 时若不显式指定，群里任何人都能点「允许」。
  const approverAllowlist =
    readStringArray(merged.approverAllowlist, "approverAllowlist", problems) ?? dmAllowlist;
  if (approverAllowlist.length === 0) {
    problems.push(
      "approverAllowlist 为空：卡片审批将无人可批。只配了 groupAllowlist 时必须显式指定谁能批准",
    );
  }

  let approvalMode: ApprovalMode = "balanced";
  if (merged.approvalMode !== undefined) {
    if (merged.approvalMode === "balanced" || merged.approvalMode === "strict") {
      approvalMode = merged.approvalMode;
    } else {
      problems.push('approvalMode 必须是 "balanced" 或 "strict"');
    }
  }

  let approvalTimeoutMs = 120_000;
  if (merged.approvalTimeoutMs !== undefined) {
    const n = merged.approvalTimeoutMs;
    if (typeof n === "number" && Number.isInteger(n) && n > 0) approvalTimeoutMs = n;
    else problems.push("approvalTimeoutMs 必须是正整数（毫秒）");
  }

  const repoRoot = path.resolve(typeof merged.repoRoot === "string" ? merged.repoRoot : cwd);

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    appId: appId as string,
    appSecret: appSecret as string,
    autoStart,
    dmAllowlist,
    groupAllowlist,
    approverAllowlist,
    requireMention,
    approvalMode,
    approvalTimeoutMs,
    repoRoot,
  };
}
