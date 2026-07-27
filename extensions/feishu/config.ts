import path from "node:path";

export type ApprovalMode = "balanced" | "strict";

export interface Config {
  appId: string;
  appSecret: string;
  autoStart: boolean;
  dmAllowlist: string[];
  groupAllowlist: string[];
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

export interface LoadConfigArgs {
  /** 低优先级在前，后面的覆盖前面的 */
  files: unknown[];
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
  for (const f of files) Object.assign(merged, asRecord(f));

  const problems: string[] = [];

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
    requireMention,
    approvalMode,
    approvalTimeoutMs,
    repoRoot,
  };
}
