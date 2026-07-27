import path from "node:path";
import type { ApprovalMode } from "./config.ts";

export type Risk = "safe" | "risky";
export type PathResolver = (p: string) => string;

const identity: PathResolver = (p) => p;

const WRITER_TOOLS = new Set(["write", "edit"]);

/** 重定向到这些目标是无害的，不触发审批 */
const SAFE_REDIRECT_TARGETS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);

const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+-[a-z]*[rf]/,
  /\bsudo\b/,
  /\b(chmod|chown)\b[^|;&]*\b777\b/,
  /\bdd\s+if=/,
  /\bmkfs(\.[a-z0-9]+)?\b/,
  /\b(curl|wget)\b[^|]*\|\s*(ba|z|k|da)?sh\b/,
  /\bgit\s+push\b[^|;&]*(--force\b|(?:^|\s)-f(?:\s|$))/,
  />\s*\/dev\/(?!null\b|stdout\b|stderr\b)/,
];

/** 匹配 `> f`、`>> f`、`2> f`、`tee f`、`tee -a f` 的目标 */
const REDIRECT_PATTERN = /(?:^|[\s;&|])(?:\d?>>?|tee(?:\s+-a)?)\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g;

export function normalizeCommand(cmd: string): string {
  return cmd.replace(/\s+/g, " ").trim().toLowerCase();
}

export function isInside(
  root: string,
  target: string,
  resolvePath: PathResolver = identity,
): boolean {
  const absRoot = path.resolve(resolvePath(path.resolve(root)));
  const absTarget = path.resolve(resolvePath(path.resolve(absRoot, target)));
  const rel = path.relative(absRoot, absTarget);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function redirectTargets(normalized: string): string[] {
  const out: string[] = [];
  for (const m of normalized.matchAll(REDIRECT_PATTERN)) {
    out.push(m[1].replace(/^["']|["']$/g, ""));
  }
  return out;
}

export interface AssessArgs {
  toolName: string;
  input: Record<string, unknown>;
  mode: ApprovalMode;
  repoRoot: string;
  resolvePath?: PathResolver;
}

export function assessRisk({
  toolName,
  input,
  mode,
  repoRoot,
  resolvePath = identity,
}: AssessArgs): Risk {
  if (mode === "strict") {
    return toolName === "bash" || WRITER_TOOLS.has(toolName) ? "risky" : "safe";
  }

  if (WRITER_TOOLS.has(toolName)) {
    const target = typeof input.path === "string" ? input.path : undefined;
    if (target === undefined) return "risky";
    return isInside(repoRoot, target, resolvePath) ? "safe" : "risky";
  }

  if (toolName === "bash") {
    const command = typeof input.command === "string" ? input.command : undefined;
    if (command === undefined) return "risky";

    const normalized = normalizeCommand(command);
    if (DANGEROUS_PATTERNS.some((re) => re.test(normalized))) return "risky";

    for (const target of redirectTargets(normalized)) {
      if (SAFE_REDIRECT_TARGETS.has(target)) continue;
      if (!isInside(repoRoot, target, resolvePath)) return "risky";
    }
    return "safe";
  }

  return "safe";
}
