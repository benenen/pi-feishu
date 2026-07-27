import path from "node:path";
import { parse } from "shell-quote";
import type { ApprovalMode } from "./config.ts";

export type Risk = "safe" | "risky";
export type PathResolver = (p: string) => string;

const identity: PathResolver = (p) => p;

const WRITER_TOOLS = new Set(["write", "edit"]);

/**
 * shell-quote 不会把这几类东西报成 operator，必须在原始串上先拒掉 ——
 * 它们都会让 token 流与 shell 实际执行的 argv 脱节：
 *   反引号  —— `whoami` 原样变成一个普通字符串 token
 *   $       —— $VAR 被静默展开成空串，`cat $SECRET` 解析成 ["cat", ""]
 *   { }     —— shell-quote 完全不做花括号展开，`find / {-delete,}` 会变成
 *              一个不以 `-` 开头的 token 被当成位置参数放过，而 bash 展开后
 *              的 argv 就是 `find / -delete`
 */
const RAW_FORBIDDEN = /[`${}]/;

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
  /** 是否允许 `-5` 这种数字标志（git log -5、head -20、find -mtime -5） */
  numeric?: boolean;
}

/** 无论子命令如何都不需要区分的只读命令 */
const READ_ONLY_COMMANDS = new Map<string, FlagPolicy>([
  ["ls", { short: "laAhRrtSU1dFi", long: new Set(["all", "almost-all", "human-readable", "reverse", "recursive", "sort", "time", "directory", "classify", "color"]) }],
  ["pwd", { short: "LP", long: new Set() }],
  ["cat", { short: "nbEsTAv", long: new Set(["number", "number-nonblank", "show-ends", "show-all"]) }],
  ["head", { short: "nqvc", numeric: true, long: new Set(["lines", "bytes", "quiet", "verbose"]) }],
  ["tail", { short: "nfqvc", numeric: true, long: new Set(["lines", "bytes", "follow", "quiet", "verbose"]) }],
  ["wc", { short: "lwcmL", long: new Set(["lines", "words", "bytes", "chars", "max-line-length"]) }],
  ["file", { short: "biL", long: new Set(["mime", "mime-type", "brief"]) }],
  ["stat", { short: "cfLt", long: new Set(["format", "printf", "dereference", "terse", "file-system"]) }],
  ["du", { short: "shcamkb", long: new Set(["summarize", "human-readable", "max-depth", "apparent-size", "total", "all"]) }],
  ["df", { short: "hTikaP", long: new Set(["human-readable", "print-type", "inodes", "all", "portability"]) }],
  ["grep", { short: "rRnivEFGPwcLloqsaHhbxzZeuABC", numeric: true, long: new Set(["recursive", "dereference-recursive", "line-number", "ignore-case", "invert-match", "extended-regexp", "fixed-strings", "basic-regexp", "perl-regexp", "word-regexp", "count", "files-with-matches", "files-without-match", "only-matching", "quiet", "no-messages", "with-filename", "no-filename", "byte-offset", "after-context", "before-context", "context", "include", "exclude", "exclude-dir", "color", "colour", "binary-files", "max-count", "text"]) }],
  ["rg", { short: "nivewcLloqSuHhpztgFABC", numeric: true, long: new Set(["glob", "iglob", "type", "type-not", "hidden", "no-ignore", "ignore-case", "line-number", "count", "count-matches", "files-with-matches", "only-matching", "context", "after-context", "before-context", "max-count", "color", "smart-case", "fixed-strings", "word-regexp", "pretty", "json", "no-heading"]) }],
  ["diff", { short: "urUqiwbBNaczpst", numeric: true, long: new Set(["unified", "recursive", "brief", "ignore-case", "ignore-all-space", "new-file", "side-by-side", "color", "text"]) }],
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
  // find 的 primary 是单横杠长词，用 word 风格；
  // -delete/-exec*/-ok*/-fprint* 不在表里，天然被拦
  ["find", { style: "word", numeric: true, long: new Set([
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
  ["npm", { subcommands: new Set(["test", "ls", "list", "outdated", "why"]), flags: { short: "sgl", long: new Set(["json", "long", "depth", "silent", "workspace", "workspaces"]) } }],
  ["pnpm", { subcommands: new Set(["test", "list", "why"]), flags: { short: "sgl", long: new Set(["json", "long", "depth", "silent"]) } }],
  ["yarn", { subcommands: new Set(["test", "list", "why"]), flags: { short: "sgl", long: new Set(["json", "depth", "silent"]) } }],
  // build 移出：-o 可写任意路径
  // fmt 移出：`cargo fmt -- <path>` 把路径直接转交 rustfmt 就地改写文件，
  // 而 `--` 之后的位置参数标志检查根本够不着 —— 与 uniq 同一类逃逸
  ["cargo", { subcommands: new Set(["check", "test", "tree", "clippy"]), flags: { short: "pv", long: new Set(["all", "workspace", "package", "lib", "bin", "tests", "quiet", "verbose", "offline", "locked", "all-features", "no-default-features", "features", "message-format"]) } }],
  // go 用单横杠长标志（-run/-json/-count），必须是 word 风格，
  // 否则 long 表根本不会被查到，全部误判为危险
  ["go", { subcommands: new Set(["test", "vet", "list"]), flags: { style: "word", long: new Set(["v", "n", "run", "count", "race", "cover", "json", "short", "timeout", "tags"]) } }],
  // inspect 移出：容器 JSON 里的 Config.Env 常带 API key
  ["docker", { subcommands: new Set(["ps", "logs", "images"]), flags: { short: "afnqt", long: new Set(["all", "tail", "since", "until", "follow", "timestamps", "format", "filter", "no-trunc", "quiet"]) } }],
]);

/**
 * 把命令解析成 shell 实际会执行的 argv。
 * 返回 undefined 表示「无法安全判定」—— 出现了操作符、命令替换、
 * 变量展开，或解析本身失败。调用方一律按危险处理。
 *
 * 用真正的 shell 解析器而不是正则 + split，是因为字符串层面的 token 流
 * 会与 shell 实际执行的内容脱节：`'--output=/etc/x'` 带引号时不以 `-`
 * 开头，naive 分词会当成位置参数放过，而 shell 剥掉引号后它仍是标志。
 */
export function parseCommand(command: string): string[] | undefined {
  if (RAW_FORBIDDEN.test(command)) return undefined;

  let entries: ReturnType<typeof parse>;
  try {
    entries = parse(command);
  } catch {
    return undefined;
  }

  const tokens: string[] = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      tokens.push(entry);
      continue;
    }
    // 操作符（管道、重定向、串联、子 shell），以及 glob。
    //
    // glob 也放弃判定：我们只看得到未展开的模式串，看不到它实际会展开成
    // 哪些 argv。仓库里若存在一个名字像标志的文件（write 工具在仓库内是
    // 无条件放行的），`ls *` 展开后就会多出一个我们从未检查过的标志。
    // 「评估的文本 ≠ 执行的 argv」正是本模块前四版反复栽的地方，不留缺口。
    return undefined;
  }
  return tokens;
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

    // 短标志簇：-la、-A3。尾部数字只有在明确允许数字标志时才剥离，
    // 否则 -L5 会绕过 numeric 门禁被当成 -L 放行。
    let letters = body;
    if (/\d+$/.test(letters)) {
      if (policy.numeric !== true) return false;
      letters = letters.replace(/\d+$/, "");
    }
    if (letters === "") return false;
    const short = policy.short ?? "";
    for (const ch of letters) {
      if (!short.includes(ch)) return false;
    }
  }
  return true;
}

export function assessBashRisk(command: string): Risk {
  const tokens = parseCommand(command);
  if (tokens === undefined) return "risky";

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
