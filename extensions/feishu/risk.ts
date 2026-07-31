import path from "node:path";
import { parse } from "shell-quote";
import type { ApprovalMode } from "./config.ts";

export type Risk = "safe" | "risky";
export type PathResolver = (p: string) => string;

const identity: PathResolver = (p) => p;

const WRITER_TOOLS = new Set(["write", "edit"]);

/** strict 档唯一免审批的工具。其余一律要批，包括扩展/MCP 注册的自定义工具。 */
const STRICT_SAFE_TOOLS = new Set(["read", "grep", "find", "ls"]);

/**
 * 把本地文件送出这台机器的工具。**任何档位都要人点头**，包括 relaxed ——
 * 另外两类（写文件、跑命令）坏在「改坏了本地」，这类坏在「发出去就收不回来」，
 * 撤回按钮救不了已经被人看到的截图。目录白名单管的是「能发哪些文件」，
 * 这道闸门管的是「这一次到底发不发」，两道都要。
 */
const EXFIL_TOOLS = new Set(["feishu_send_image"]);

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
  /**
   * 位置参数个数上限。`uniq 输入 输出` 的第二个位置参数就是输出文件 ——
   * 不含任何标志也不含任何 shell 元字符，只能靠数个数拦。
   * 未设置表示不限制。标志的取值也会被算作位置参数，宁可多拦。
   */
  maxPositionals?: number;
}

/** 无论子命令如何都不需要区分的只读命令 */
const READ_ONLY_COMMANDS = new Map<string, FlagPolicy>([
  ["ls", { short: "laAhRrtSU1dFi", long: new Set(["all", "almost-all", "human-readable", "reverse", "recursive", "sort", "time", "directory", "classify", "color"]) }],
  ["pwd", { short: "LP", long: new Set() }],
  // shell 内建，没有任何写能力；`cd 某目录 && 只读命令` 是高频写法
  ["cd", { short: "LP", maxPositionals: 1, long: new Set() }],
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
  // 管道里的常用过滤器。写文件的口子逐个堵掉：
  // sort 的 -o/--output、tree 的 -o —— 都能把任意内容落到任意路径
  ["sort", { short: "bcdfghiMnrRsuVzk", numeric: true, long: new Set(["reverse", "numeric-sort", "general-numeric-sort", "human-numeric-sort", "version-sort", "month-sort", "unique", "ignore-case", "ignore-leading-blanks", "dictionary-order", "key", "field-separator", "stable", "check", "zero-terminated", "buffer-size", "parallel"]) }],
  // uniq 的第二个位置参数就是输出文件，只能靠 maxPositionals 拦
  ["uniq", { short: "cdDiufswz", numeric: true, maxPositionals: 1, long: new Set(["count", "repeated", "all-repeated", "unique", "ignore-case", "skip-fields", "skip-chars", "check-chars", "zero-terminated"]) }],
  ["tr", { short: "dscCt", long: new Set(["delete", "squeeze-repeats", "complement", "truncate-set1"]) }],
  ["tac", { short: "brs", long: new Set(["before", "regex", "separator"]) }],
  ["comm", { short: "123zi", numeric: true, long: new Set(["check-order", "nocheck-order", "output-delimiter", "total", "zero-terminated"]) }],
  // tree 的 -o 写文件，刻意不列
  ["tree", { short: "adfilnpsugDLRCF", numeric: true, long: new Set(["dirsfirst", "noreport", "filelimit", "prune", "level", "charset", "du", "sort"]) }],
  // jq 没有写文件的能力（没有 -i / -o）。注意含 {} 的 filter 会先被 RAW_FORBIDDEN 拦掉
  ["jq", { short: "renjcsSaMC", long: new Set(["raw-output", "raw-input", "null-input", "compact-output", "slurp", "sort-keys", "exit-status", "tab", "indent", "arg", "argjson", "args", "jsonargs", "join-output", "ascii-output", "monochrome-output", "color-output", "seq", "stream"]) }],
  ["seq", { short: "swf", long: new Set(["separator", "equal-width", "format"]) }],
  // -c 是校验模式，读取校验文件，不写
  ["sha256sum", { short: "bctwz", long: new Set(["binary", "check", "tag", "text", "quiet", "status", "warn", "zero"]) }],
  ["sha1sum", { short: "bctwz", long: new Set(["binary", "check", "tag", "text", "quiet", "status", "warn", "zero"]) }],
  ["sha512sum", { short: "bctwz", long: new Set(["binary", "check", "tag", "text", "quiet", "status", "warn", "zero"]) }],
  ["md5sum", { short: "bctwz", long: new Set(["binary", "check", "tag", "text", "quiet", "status", "warn", "zero"]) }],
  ["cksum", { short: "a", long: new Set(["algorithm", "untagged"]) }],
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
  // node/tsc 借用「子命令」这一层来强制第一个参数：
  // `node --test` 跑的是仓库自己的测试，与已放行的 `npm test` 同级；
  // 而 `node -e '…'` / `node script.js` 是直接执行任意代码，必须挡住。
  ["node", { subcommands: new Set(["--test"]), flags: { long: new Set(["test-reporter", "test-name-pattern", "test-concurrency", "test-only", "experimental-strip-types"]) } }],
  // tsc 不带 --noEmit 会落地产物，--outDir 更是能写任意目录
  ["tsc", { subcommands: new Set(["--noemit"]), flags: { long: new Set(["project", "pretty", "incremental"]) } }],
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
/**
 * 可以按段拆开逐段判定的操作符。它们只决定「下一段跑不跑」，
 * 不会把数据写到任何地方 —— 每段自己仍要过白名单，`ls | sh` 照样死在 sh 上。
 *
 * 重定向（`>` `>>` `<` `2>`）刻意不在此列：它能把任意内容写进任意路径，
 * 而写入目标是操作数不是命令，逐段判定根本看不见它。
 */
const SPLITTABLE_OPS = new Set(["|", "&&", "||", ";"]);

/**
 * 把命令拆成 shell 实际会执行的若干段 argv。
 * 返回 undefined 表示「无法安全判定」—— 出现了重定向、后台、子 shell、
 * 命令替换、变量展开、glob，或解析本身失败。调用方一律按危险处理。
 *
 * 用真正的 shell 解析器而不是正则 + split，是因为字符串层面的 token 流
 * 会与 shell 实际执行的内容脱节：`'--output=/etc/x'` 带引号时不以 `-`
 * 开头，naive 分词会当成位置参数放过，而 shell 剥掉引号后它仍是标志。
 */
export function parseSegments(command: string): string[][] | undefined {
  if (RAW_FORBIDDEN.test(command)) return undefined;

  let entries: ReturnType<typeof parse>;
  try {
    entries = parse(command);
  } catch {
    return undefined;
  }

  const segments: string[][] = [];
  let current: string[] = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      current.push(entry);
      continue;
    }
    // 可拆分的操作符：收束当前段，开下一段
    if ("op" in entry && typeof entry.op === "string" && SPLITTABLE_OPS.has(entry.op)) {
      segments.push(current);
      current = [];
      continue;
    }
    // 其余操作符（重定向、后台、子 shell），以及 glob。
    //
    // glob 也放弃判定：我们只看得到未展开的模式串，看不到它实际会展开成
    // 哪些 argv。仓库里若存在一个名字像标志的文件（write 工具在仓库内是
    // 无条件放行的），`ls *` 展开后就会多出一个我们从未检查过的标志。
    // 「评估的文本 ≠ 执行的 argv」正是本模块前四版反复栽的地方，不留缺口。
    return undefined;
  }
  segments.push(current);

  // 空段意味着 `ls |`、`| ls`、`ls ;; cat` 这类我们没把握复现的写法，放弃判定
  if (segments.some((s) => s.length === 0)) return undefined;
  return segments;
}

/** shell-quote 会把重定向报成 operator，其后紧跟的字符串就是目标 */
const REDIRECT_OPS = new Set([">", ">>", "<", "<<", "<<<", ">&", "<&", "&>", "&>>"]);

export interface ShellRedirect {
  op: string;
  target: string;
}

export interface ShellSegment {
  /** 命令名 + 参数，**不含**重定向与其目标 */
  argv: string[];
  redirects: ShellRedirect[];
  /** 本段与下一段之间的连接符（`|` / `&&` / `||` / `;`），末段为 undefined */
  nextOp?: string;
}

/**
 * 比 parseSegments 更细的一层：保留重定向目标与段间连接符。
 *
 * relaxed 档需要它才能问出结构性的问题 ——「这个 token 是命令名还是参数」
 * 「这个路径是重定向目标还是位置参数」。在原始串上扫正则回答不了这些，
 * 于是 `grep rm notes.txt` 会因为出现 `rm` 被拦、`2>/dev/null` 会被当成写 /dev。
 *
 * 返回 undefined 表示放弃判定（glob、变量展开、命令替换、未知操作符），
 * 调用方应退回更保守的手段。
 */
export function parseShell(command: string): ShellSegment[] | undefined {
  if (RAW_FORBIDDEN.test(command)) return undefined;

  let entries: ReturnType<typeof parse>;
  try {
    entries = parse(command);
  } catch {
    return undefined;
  }

  const segments: ShellSegment[] = [];
  let argv: string[] = [];
  let redirects: ShellRedirect[] = [];

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (typeof entry === "string") {
      argv.push(entry);
      continue;
    }
    if (!(entry !== null && typeof entry === "object" && "op" in entry)) return undefined;
    const op = String((entry as { op: unknown }).op);

    if (SPLITTABLE_OPS.has(op)) {
      segments.push({ argv, redirects, nextOp: op });
      argv = [];
      redirects = [];
      continue;
    }

    if (REDIRECT_OPS.has(op)) {
      // `cat a 2>/dev/null` 解析成 ["cat","a","2",{op:">"},"/dev/null"]——
      // 那个 "2" 是文件描述符，不是位置参数，不摘掉会被当成命令的参数
      if (argv.length > 0 && /^\d+$/.test(argv[argv.length - 1] as string)) argv.pop();
      const target = entries[i + 1];
      if (typeof target !== "string") return undefined;
      redirects.push({ op, target });
      i += 1;
      continue;
    }

    // glob 与其余操作符（后台、子 shell）：看不到展开结果，放弃
    return undefined;
  }
  segments.push({ argv, redirects });

  if (segments.some((s) => s.argv.length === 0)) return undefined;
  return segments;
}

/** 单段命令的 argv；命令含可拆分操作符时返回 undefined */
export function parseCommand(command: string): string[] | undefined {
  const segments = parseSegments(command);
  if (segments === undefined || segments.length !== 1) return undefined;
  return segments[0];
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
  let positionals = 0;
  for (const token of tokens) {
    if (token === "-" || token === "--" || !token.startsWith("-")) {
      positionals += 1;
      if (policy.maxPositionals !== undefined && positionals > policy.maxPositionals) return false;
      continue;
    }

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
  const segments = parseSegments(command);
  if (segments === undefined) return "risky";
  // 逐段判定，一段不安全整条就不安全
  return segments.every((s) => assessSegment(s) === "safe") ? "safe" : "risky";
}

function assessSegment(tokens: readonly string[]): Risk {
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

/**
 * relaxed 档的危险模式。
 *
 * 这是一份**黑名单**，与 balanced/strict 的白名单模型相反 —— 枚举危险必然有漏网，
 * 这正是 relaxed 用便利换来的代价。只在你信任 agent 与仓库环境时启用。
 * 直接扫原始命令串而不是解析后的 argv：解析失败（重定向、glob、变量展开）
 * 在本档不再等于危险，但那些写法照样能藏破坏性命令，正则至少还能兜一层。
 */
const RELAXED_DANGEROUS: readonly RegExp[] = [
  // 删除、覆写、改权限、改用户、改系统状态
  /\b(rm|rmdir|shred|truncate|dd|fdisk|parted|mkfs\S*|mount|umount)\b/,
  /\b(chmod|chown|chgrp|useradd|userdel|usermod|passwd|visudo)\b/,
  /\b(sudo|su|doas)\b/,
  /\b(shutdown|reboot|halt|poweroff|init)\b/,
  // 这几个都有纯只读的子命令（systemctl show-environment / status、
  // service X status、iptables -L、crontab -l、nft list）。整词一刀切会把
  // 排查类命令全部误判成危险，所以只拦「会改状态」的用法：
  // 用否定先行断言列出只读子命令，其余一律拦 —— 标志夹在中间
  // （systemctl -q stop x）也会因为不匹配只读表而被拦下。
  /\bsystemctl\s+(?!(show-environment|show|status|cat|list-\S*|is-\S*|get-default)\b)/,
  /\bservice\s+\S+\s+(?!status\b)\S/,
  /\biptables\b(?!\s+(-L|-S|--list|--list-rules)\b)/,
  /\bcrontab\b(?!\s+(-l|--list)\b)/,
  /\bnft\b(?!\s+list\b)/,
  /\b(kill|killall|pkill)\b/,
  // 下载后直接执行。解析放弃时才会走到这里，精度有限，但至少要求管道另一头
  // 确实是个能执行的东西 —— 只看「curl 后面有管道」会把 curl|grep 全误伤。
  // `\|\s*` 锚在管道口，所以 `curl … | grep bash` 里的 bash 不算
  /\b(curl|wget)\b.*\|\s*(sudo\s+|env\s+)?(sh|bash|zsh|dash|ksh|ash|python3?|perl|ruby|node|php|lua|xargs)\b/,
  // 往仓库外的系统目录写
  />\s*\/(etc|usr|bin|sbin|boot|lib|var|root)\b/,
  // /dev 单独处理：`2>/dev/null` 是丢弃输出，不是写系统目录，一刀切会把
  // 几乎每条带静默重定向的命令都误判成危险。真正要拦的是写块设备（`> /dev/sda`
  // 直接毁盘），所以放行标准的位桶，其余 /dev 目标照拦。
  />\s*\/dev\/(?!null\b|zero\b|stdout\b|stderr\b|tty\b|fd\/)/,
  // 不可逆的对外动作
  /\bgit\s+push\b/,
  /\bnpm\s+publish\b/,
  /\bdocker\s+(rm|rmi|prune)\b/,
  /\bsystem\s+prune\b/,
];

export interface RelaxedPatterns {
  /** 追加到内置默认之上的危险模式（正则源串） */
  deny?: readonly string[];
  /** 例外：命中即放行，优先于所有 deny —— 用来给内置规则开口子 */
  allow?: readonly string[];
}

/**
 * 编译用户配置里的正则。配置加载时已经校验过可编译，这里再包一层是因为
 * 本函数也被直接调用（测试、其他调用方）—— 编译失败宁可当作「这条规则不存在」
 * 也不能抛异常：assessRisk 抛错会走到 gateToolCall 的 catch，把整批调用判危险。
 */
function compile(sources: readonly string[] | undefined): RegExp[] {
  const out: RegExp[] = [];
  for (const src of sources ?? []) {
    try {
      out.push(new RegExp(src));
    } catch {
      // 忽略：配置校验已经拦过，走到这里说明是直接调用方传了坏值
    }
  }
  return out;
}

/** 作为命令名出现即危险，无需再看参数 */
const DANGEROUS_HEADS = new Set([
  "rm", "rmdir", "shred", "truncate", "dd", "fdisk", "parted", "mount", "umount",
  "chmod", "chown", "chgrp", "useradd", "userdel", "usermod", "passwd", "visudo",
  "sudo", "su", "doas",
  "shutdown", "reboot", "halt", "poweroff", "init",
  "kill", "killall", "pkill",
]);

/**
 * 有只读子命令的工具：整词拦会把排查类命令全误伤（`systemctl show-environment`
 * 曾经就栽在这），所以判第一个参数。返回 true 表示这次调用是只读的。
 */
const READONLY_GUARDED = new Map<string, (rest: readonly string[]) => boolean>([
  ["systemctl", (r) => {
    const sub = r[0];
    if (sub === undefined) return true; // 裸 systemctl 只列单元
    return (
      ["show-environment", "show", "status", "cat", "get-default"].includes(sub) ||
      sub.startsWith("list-") ||
      sub.startsWith("is-")
    );
  }],
  // `service X status` 才是只读；`service --status-all` 没有第二个参数
  ["service", (r) => r.length < 2 || r[1] === "status"],
  ["iptables", (r) => ["-L", "-S", "--list", "--list-rules"].includes(r[0] ?? "")],
  ["crontab", (r) => ["-l", "--list"].includes(r[0] ?? "")],
  ["nft", (r) => r[0] === "list"],
]);

/** 命令 + 子命令才危险 */
const DANGEROUS_PAIRS = new Map<string, ReadonlySet<string>>([
  ["git", new Set(["push"])],
  ["npm", new Set(["publish"])],
  ["docker", new Set(["rm", "rmi", "prune"])],
]);

/** 下载后直接执行：这一段是 curl/wget 且被管到下一段 */
const DOWNLOADERS = new Set(["curl", "wget"]);

/**
 * 会把标准输入当成「要执行的东西」的命令。
 *
 * `curl … | sh` 危险的是**执行**，不是下载。早先的规则只看「curl 后面跟了管道」，
 * 于是 `curl … | grep`、`… | jq`、`… | head` 这些最常见的排查动作全被判成危险 ——
 * relaxed 档因此名存实亡。
 *
 * 宁可多列几个：列进来只是多问一次审批，漏掉才是真放行。
 */
const PIPE_EXECUTORS = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "ash", "fish", "csh", "tcsh",
  "python", "python2", "python3", "perl", "ruby", "node", "nodejs", "php", "lua",
  // xargs 把标准输入拼成命令行执行，`curl … | xargs rm` 一样是执行下载来的内容
  "xargs",
  // 包装器：`curl … | env python`、`curl … | sudo sh`
  "env", "sudo", "doas", "eval",
]);

/** 写到这些顶层目录即危险 */
const SYSTEM_DIRS = new Set(["etc", "usr", "bin", "sbin", "boot", "lib", "var", "root"]);

/** /dev 下这几个是丢弃输出用的位桶，不是「写设备」 */
const DEV_BIT_BUCKETS = new Set(["null", "zero", "stdout", "stderr", "tty"]);

function riskyRedirectTarget(target: string): boolean {
  if (!target.startsWith("/")) return false; // 相对路径由 write/edit 的仓库边界管
  if (target.startsWith("/dev/")) {
    const rest = target.slice(5);
    return !(DEV_BIT_BUCKETS.has(rest) || rest.startsWith("fd/"));
  }
  return SYSTEM_DIRS.has(target.split("/")[1] ?? "");
}

/**
 * 结构化判定：问的是「这个 token 是不是命令名」「这个路径是不是重定向目标」，
 * 而不是「这坨文本里有没有出现 rm」。后者会把 `grep rm notes.txt` 判危险。
 */
/** 从第 i 段起顺着 `|` 往后走，看有没有哪一段会把标准输入当命令执行 */
function pipedIntoExecutor(segments: readonly ShellSegment[], i: number): boolean {
  for (let j = i; segments[j]?.nextOp === "|"; j += 1) {
    const next = segments[j + 1];
    if (!next) return false;
    if (PIPE_EXECUTORS.has(path.basename(next.argv[0] ?? "").toLowerCase())) return true;
  }
  return false;
}

function relaxedStructuralRisk(segments: readonly ShellSegment[]): Risk {
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    // 按 basename 取命令名，`/bin/rm` 骗不过去
    const head = path.basename(seg.argv[0] ?? "").toLowerCase();
    const rest = seg.argv.slice(1);

    if (DANGEROUS_HEADS.has(head) || head.startsWith("mkfs")) return "risky";

    const readonlyCheck = READONLY_GUARDED.get(head);
    if (readonlyCheck && !readonlyCheck(rest)) return "risky";

    const pair = DANGEROUS_PAIRS.get(head);
    if (pair && rest[0] !== undefined && pair.has(rest[0])) return "risky";
    if (head === "docker" && rest[0] === "system" && rest[1] === "prune") return "risky";

    // 下载**并执行**才危险。只看「后面有管道」会把 curl|grep 这类排查动作全误伤，
    // 所以顺着管道往后找，看有没有哪一段会把内容当命令跑
    if (DOWNLOADERS.has(head) && seg.nextOp === "|" && pipedIntoExecutor(segments, i)) {
      return "risky";
    }

    if (seg.redirects.some((r) => riskyRedirectTarget(r.target))) return "risky";
  }
  return "safe";
}

export function assessRelaxedBashRisk(command: string, extra?: RelaxedPatterns): Risk {
  // allow 先判且优先级最高：它存在的意义就是给内置规则开口子
  if (compile(extra?.allow).some((re) => re.test(command))) return "safe";

  const segments = parseShell(command);
  const builtinRisk =
    segments === undefined
      ? // 解析放弃（glob / 变量展开 / 命令替换）—— 退回在原始串上扫正则。
        // 精度差，但总比看不见强：`rm -rf $DIR` 仍然会被兜住
        (RELAXED_DANGEROUS.some((re) => re.test(command)) ? "risky" : "safe")
      : relaxedStructuralRisk(segments);
  if (builtinRisk === "risky") return "risky";

  // 用户自配的黑名单是正则契约，仍按原始串匹配
  return compile(extra?.deny).some((re) => re.test(command)) ? "risky" : "safe";
}

export interface AssessArgs {
  toolName: string;
  input: Record<string, unknown>;
  mode: ApprovalMode;
  repoRoot: string;
  resolvePath?: PathResolver;
  /** relaxed 档的自定义黑名单（追加）与例外（优先放行） */
  denyPatterns?: readonly string[];
  allowPatterns?: readonly string[];
}

export function assessRisk({
  toolName,
  input,
  mode,
  repoRoot,
  resolvePath = identity,
  denyPatterns,
  allowPatterns,
}: AssessArgs): Risk {
  if (mode === "strict") {
    // 安全清单而非危险清单：扩展和 MCP 服务器能注册任意名字的工具，
    // 它们照样会写文件、起子进程。枚举危险名字必然漏，
    // 而 strict 卖点正是「完全不信任的环境」。
    return STRICT_SAFE_TOOLS.has(toolName) ? "safe" : "risky";
  }

  if (EXFIL_TOOLS.has(toolName)) return "risky";

  if (WRITER_TOOLS.has(toolName)) {
    const target = typeof input.path === "string" ? input.path : undefined;
    if (target === undefined) return "risky";
    return isInside(repoRoot, target, resolvePath) ? "safe" : "risky";
  }

  if (toolName === "bash") {
    const command = typeof input.command === "string" ? input.command : undefined;
    if (command === undefined) return "risky";
    return mode === "relaxed"
      ? assessRelaxedBashRisk(command, { deny: denyPatterns, allow: allowPatterns })
      : assessBashRisk(command);
  }

  return "safe";
}
