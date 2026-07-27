import path from "node:path";
import type { ApprovalMode } from "./config.ts";

export type Risk = "safe" | "risky";
export type PathResolver = (p: string) => string;

const identity: PathResolver = (p) => p;

const WRITER_TOOLS = new Set(["write", "edit"]);

/**
 * 任一 shell 元字符出现即判危险 —— 重定向、管道、命令替换、命令串联、
 * 子 shell 全靠这一条拦下，不必逐一枚举危险写法。
 * 刻意不解析引号：引号内的括号会被误判为危险，多弹一次审批，方向偏安全。
 */
const SHELL_METACHARACTERS = /[|&;<>$`(){}\n\r\\]/;

/** 无论参数如何都只读的命令 */
const READ_ONLY_COMMANDS = new Set([
  "ls", "pwd", "cat", "head", "tail", "wc", "file", "stat", "du", "df", "tree",
  "grep", "rg", "ag", "diff", "sort", "uniq", "cut", "basename", "dirname",
  "realpath", "readlink", "whoami", "hostname", "uname", "date", "echo",
  "printenv", "which", "type", "id", "ps", "man",
]);

/** 多用途命令：只有列出的子命令算只读 */
const READ_ONLY_SUBCOMMANDS = new Map<string, ReadonlySet<string>>([
  ["git", new Set([
    "status", "diff", "log", "show", "branch", "ls-files", "remote",
    "describe", "blame", "shortlog", "rev-parse", "tag",
  ])],
  ["npm", new Set(["test", "run", "ls", "list", "outdated", "view", "why"])],
  ["pnpm", new Set(["test", "run", "list", "why"])],
  ["yarn", new Set(["test", "run", "list", "why"])],
  ["cargo", new Set(["check", "test", "tree", "fmt", "clippy"])],
  ["go", new Set(["test", "vet", "list", "build"])],
  ["docker", new Set(["ps", "logs", "images", "inspect"])],
  ["kubectl", new Set(["get", "describe", "logs"])],
]);

/** find 带上这些标志就不再是只读 */
const FIND_MUTATING_FLAGS = new Set([
  "-delete", "-exec", "-execdir", "-ok", "-okdir", "-fls", "-fprint", "-fprintf",
]);

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

export function assessBashRisk(command: string): Risk {
  // 元字符检查用原始串，归一化会丢掉换行
  if (SHELL_METACHARACTERS.test(command)) return "risky";

  const tokens = normalizeCommand(command).split(" ").filter((t) => t !== "");
  const head = tokens[0];
  if (head === undefined) return "risky";

  if (head === "find") {
    return tokens.some((t) => FIND_MUTATING_FLAGS.has(t)) ? "risky" : "safe";
  }

  const subcommands = READ_ONLY_SUBCOMMANDS.get(head);
  if (subcommands) {
    const sub = tokens[1];
    return sub !== undefined && subcommands.has(sub) ? "safe" : "risky";
  }

  return READ_ONLY_COMMANDS.has(head) ? "safe" : "risky";
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
    return assessBashRisk(command);
  }

  return "safe";
}
