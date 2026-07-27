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

/**
 * 允许的标志。命令一旦出现未列出的 `-xxx` 就判危险。
 * 只列命令名不够 —— `git log --output=`、`sort -o`、`find -fprint0`
 * 都能把任意内容写进任意路径，且不含任何 shell 元字符。
 */
export interface FlagPolicy {
  /** cluster：`-la` 拆成字母逐个校验（默认）。word：`-name` 整体查 long 表（find 风格）。 */
  style?: "cluster" | "word";
  /** cluster 风格下允许的单字母标志，大小写敏感 */
  short?: string;
  /** 允许的长标志名，不含前缀 `--`，不含 `=value` */
  long: ReadonlySet<string>;
  /** 是否允许 `-5` 这种数字标志（git log -5、head -20） */
  numeric?: boolean;
}

/** 无论子命令如何都不需要区分的只读命令 */
const READ_ONLY_COMMANDS = new Map<string, FlagPolicy>([
  ["ls", { short: "laAhRrtSU1dFi", long: new Set(["all", "almost-all", "human-readable", "reverse", "recursive", "sort", "time", "directory", "classify", "color"]) }],
  ["pwd", { short: "LP", long: new Set() }],
  ["cat", { short: "nbEsTA", long: new Set(["number", "number-nonblank", "show-ends", "show-all"]) }],
  ["head", { short: "nqvc", numeric: true, long: new Set(["lines", "bytes", "quiet", "verbose"]) }],
  ["tail", { short: "nfqvc", numeric: true, long: new Set(["lines", "bytes", "follow", "quiet", "verbose"]) }],
  ["wc", { short: "lwcmL", long: new Set(["lines", "words", "bytes", "chars", "max-line-length"]) }],
  ["file", { short: "biL", long: new Set(["mime", "mime-type", "brief"]) }],
  ["stat", { short: "cfLt", long: new Set(["format", "printf", "dereference", "terse", "file-system"]) }],
  ["du", { short: "shcamkb", long: new Set(["summarize", "human-readable", "max-depth", "apparent-size", "total", "all"]) }],
  ["df", { short: "hTikaP", long: new Set(["human-readable", "print-type", "inodes", "all", "portability"]) }],
  ["grep", { short: "rRnivEFGPwcLloqsaHhbxzZeuABC", numeric: true, long: new Set(["recursive", "dereference-recursive", "line-number", "ignore-case", "invert-match", "extended-regexp", "fixed-strings", "basic-regexp", "perl-regexp", "word-regexp", "count", "files-with-matches", "files-without-match", "only-matching", "quiet", "no-messages", "with-filename", "no-filename", "byte-offset", "after-context", "before-context", "context", "include", "exclude", "exclude-dir", "color", "colour", "binary-files", "max-count", "text"]) }],
  ["rg", { short: "nivewcLloqSuHhpztgFA BC", numeric: true, long: new Set(["glob", "iglob", "type", "type-not", "hidden", "no-ignore", "ignore-case", "line-number", "count", "count-matches", "files-with-matches", "only-matching", "context", "after-context", "before-context", "max-count", "color", "smart-case", "fixed-strings", "word-regexp", "pretty", "json", "no-heading"]) }],
  ["diff", { short: "urUqiwbBNaczpst", numeric: true, long: new Set(["unified", "recursive", "brief", "ignore-case", "ignore-all-space", "new-file", "side-by-side", "color", "text"]) }],
  ["uniq", { short: "cdiuzw", long: new Set(["count", "repeated", "unique", "ignore-case"]) }],
  ["cut", { short: "dfcsb", long: new Set(["delimiter", "fields", "characters", "bytes", "only-delimited"]) }],
  ["basename", { short: "asz", long: new Set(["suffix", "multiple", "zero"]) }],
  ["dirname", { short: "z", long: new Set(["zero"]) }],
  ["realpath", { short: "emqszLP", long: new Set(["canonicalize-existing", "canonicalize-missing", "quiet", "relative-to", "zero"]) }],
  ["readlink", { short: "femnqsvz", long: new Set(["canonicalize", "canonicalize-existing", "canonicalize-missing", "no-newline", "quiet", "silent", "verbose", "zero"]) }],
  ["whoami", { short: "", long: new Set() }],
  ["id", { short: "unrgGZ", long: new Set(["user", "name", "real", "group", "groups", "zero"]) }],
  ["uname", { short: "asrvmnpio", long: new Set(["all", "kernel-name", "kernel-release", "machine", "nodename", "operating-system"]) }],
  // -s/--set 会改系统时钟，刻意不列
  ["date", { short: "uRd", long: new Set(["utc", "universal", "rfc-3339", "iso-8601", "date", "debug"]) }],
  ["echo", { short: "neE", long: new Set() }],
  ["which", { short: "a", long: new Set(["all"]) }],
  ["type", { short: "at", long: new Set() }],
  ["ps", { short: "efauxwlHjLTcno", long: new Set(["pid", "user", "format", "sort", "no-headers", "forest"]) }],
  // find 的 primary 是单横杠长词，用 word 风格；-delete/-exec*/-ok*/-fprint* 不在表里，天然被拦
  ["find", { style: "word", long: new Set([
    "L", "H", "P", "name", "iname", "path", "ipath", "regex", "iregex", "type",
    "maxdepth", "mindepth", "size", "empty", "mtime", "mmin", "newer", "newermt",
    "user", "group", "perm", "links", "lname", "samefile", "print", "print0",
    "printf", "prune", "follow", "xdev", "mount", "not", "and", "or", "a", "o",
    "true", "false", "readable", "writable", "executable", "nouser", "nogroup", "depth",
  ]) }],
]);

interface SubcommandPolicy {
  subcommands: ReadonlySet<string>;
  flags: FlagPolicy;
}

/** 多用途命令：先看子命令，再看标志 */
const READ_ONLY_SUBCOMMANDS = new Map<string, SubcommandPolicy>([
  ["git", {
    // branch/tag/remote 移出：-D 删分支、-d 删标签、set-url 改远端
    subcommands: new Set(["status", "diff", "log", "show", "ls-files", "describe", "blame", "shortlog", "rev-parse"]),
    // --output 刻意不列：git log/diff/show 都能用它写任意文件
    flags: { short: "npsuvzSwWMC", numeric: true, long: new Set(["oneline", "graph", "stat", "numstat", "name-only", "name-status", "patch", "no-patch", "no-pager", "decorate", "no-color", "color", "abbrev-commit", "pretty", "format", "date", "since", "until", "author", "committer", "grep", "follow", "reverse", "first-parent", "merges", "no-merges", "cached", "staged", "word-diff", "unified", "short", "porcelain", "all", "max-count", "skip", "summary"]) },
  }],
  // run 移出：执行 package.json 里的任意脚本
  ["npm", { subcommands: new Set(["test", "ls", "list", "outdated", "view", "why"]), flags: { short: "sgl", long: new Set(["json", "long", "depth", "silent", "workspace", "workspaces"]) } }],
  ["pnpm", { subcommands: new Set(["test", "list", "why"]), flags: { short: "sgl", long: new Set(["json", "long", "depth", "silent"]) } }],
  ["yarn", { subcommands: new Set(["test", "list", "why"]), flags: { short: "sgl", long: new Set(["json", "depth", "silent"]) } }],
  // build 移出：-o 可写任意路径
  ["cargo", { subcommands: new Set(["check", "test", "tree", "clippy", "fmt"]), flags: { short: "pv", long: new Set(["all", "workspace", "package", "lib", "bin", "tests", "quiet", "verbose", "offline", "locked", "all-features", "no-default-features", "features", "message-format"]) } }],
  ["go", { subcommands: new Set(["test", "vet", "list"]), flags: { short: "vn", long: new Set(["run", "count", "race", "cover", "json", "short", "timeout", "tags"]) } }],
  ["docker", { subcommands: new Set(["ps", "logs", "images", "inspect"]), flags: { short: "afnqt", long: new Set(["all", "tail", "since", "until", "follow", "timestamps", "format", "filter", "no-trunc", "quiet"]) } }],
  ["kubectl", { subcommands: new Set(["get", "describe", "logs"]), flags: { short: "noAlfc", long: new Set(["namespace", "output", "all-namespaces", "selector", "follow", "tail", "container", "since"]) } }],
]);

/** 只折叠空白，**不**改大小写 —— 标志的大小写有语义 */
export function normalizeCommand(cmd: string): string {
  return cmd.replace(/\s+/g, " ").trim();
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

export function flagsAllowed(tokens: readonly string[], policy: FlagPolicy): boolean {
  for (const token of tokens) {
    if (token === "-" || token === "--" || !token.startsWith("-")) continue;

    if (token.startsWith("--")) {
      const name = token.slice(2).split("=", 1)[0];
      if (!policy.long.has(name)) return false;
      continue;
    }

    const body = token.slice(1).split("=", 1)[0];

    if (/^\d+$/.test(body)) {
      if (policy.numeric !== true) return false;
      continue;
    }

    if (policy.style === "word") {
      if (!policy.long.has(body)) return false;
      continue;
    }

    // 短标志簇：-la、-A3
    const letters = body.replace(/\d+$/, "");
    if (letters === "") return false;
    const short = policy.short ?? "";
    for (const ch of letters) {
      if (!short.includes(ch)) return false;
    }
  }
  return true;
}

export function assessBashRisk(command: string): Risk {
  // 元字符检查用原始串，归一化会丢掉换行
  if (SHELL_METACHARACTERS.test(command)) return "risky";

  const tokens = normalizeCommand(command).split(" ").filter((t) => t !== "");
  const head = tokens[0]?.toLowerCase();
  if (head === undefined) return "risky";

  const grouped = READ_ONLY_SUBCOMMANDS.get(head);
  if (grouped) {
    const sub = tokens[1]?.toLowerCase();
    if (sub === undefined || !grouped.subcommands.has(sub)) return "risky";
    return flagsAllowed(tokens.slice(2), grouped.flags) ? "safe" : "risky";
  }

  const policy = READ_ONLY_COMMANDS.get(head);
  if (policy === undefined) return "risky";
  return flagsAllowed(tokens.slice(1), policy) ? "safe" : "risky";
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
