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
  // 下载后直接执行
  /\b(curl|wget)\b[^|]*\|/,
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

export function assessRelaxedBashRisk(command: string, extra?: RelaxedPatterns): Risk {
  // allow 先判且优先级最高：它存在的意义就是给内置规则开口子
  if (compile(extra?.allow).some((re) => re.test(command))) return "safe";
  const deny = [...RELAXED_DANGEROUS, ...compile(extra?.deny)];
  return deny.some((re) => re.test(command)) ? "risky" : "safe";
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
