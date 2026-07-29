import fs from "node:fs";
import path from "node:path";

export type ApprovalMode = "balanced" | "strict" | "relaxed";

/**
 * open：所有人都能私聊和群聊里触达机器人
 * allowlist：只允许名单内的用户/群
 */
export type DmMode = "open" | "allowlist";

export interface Config {
  appId: string;
  appSecret: string;
  autoStart: boolean;
  dmMode: DmMode;
  dmAllowlist: string[];
  groupAllowlist: string[];
  /** 谁的卡片点击算数。飞书 SDK 不对 card.action.trigger 做任何白名单过滤 */
  approverAllowlist: string[];
  /** start 后主动私信谁并绑定该私聊。未配则取 approverAllowlist 第一个 */
  operatorOpenId: string;
  /**
   * start 后绑定谁：
   *   "operator" —— 私信 operatorOpenId 并绑定该私聊（默认）
   *   "none"     —— 不主动绑，等第一条入站消息（群里 @ 要用这个或直接填群 id）
   *   "code"     —— 终端显示一个配对码，谁在飞书里输入它就绑谁
   *   "oc_xxx"   —— 直接绑定该会话（群）
   */
  bindTarget: string;
  /** 配对码有效期。过期即作废，需要重新 /feishu start 或 /feishu pair 签发 */
  pairingTtlMs: number;
  /**
   * 一个 pi 会话同时服务多个对话（私聊 + 群 @），回复回到消息来源。
   * 仅 direct 档有效 —— broker 档下一个会话本就只绑一个对话。
   */
  multiChat: boolean;
  /**
   * 开始处理一条入站消息时给它加的表情回应，充当「已读/在处理」的信号 ——
   * 飞书没有给机器人「标记已读」的接口，表情是通行做法。置空字符串则关闭。
   * 取值是飞书的具名表情 key（不是 Unicode 表情）。
   */
  readReceiptEmoji: string;
  requireMention: boolean;
  approvalMode: ApprovalMode;
  /** relaxed 档追加的危险模式（正则源串），加载时已校验可编译 */
  denyPatterns: string[];
  /** relaxed 档的例外，命中即放行，优先于所有 deny */
  allowPatterns: string[];
  approvalTimeoutMs: number;
  repoRoot: string;
  /** direct：会话自己连飞书（默认）；broker：经本地 broker 进程共用一条连接 */
  transport: "direct" | "broker";
  /** broker 档下的 Unix socket 路径 */
  brokerSocket: string;
  /**
   * broker 档下，会话启动时若发现 broker 没在跑就自动拉起。
   * 交给 supervisor 之类托管时关掉它 —— 否则谁都能拉起一个不受管理的进程。
   */
  autoStartBroker: boolean;
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
  /** brokerSocket 默认值所在目录；缺省时退回 cwd（历史调用点不必都跟着改） */
  agentDir?: string;
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

export function loadConfig({ files, env, cwd, agentDir }: LoadConfigArgs): Config {
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
  const autoStartBroker = readBoolean(merged.autoStartBroker, "autoStartBroker", true, problems);
  const requireMention = readBoolean(merged.requireMention, "requireMention", true, problems);
  const multiChat = readBoolean(merged.multiChat, "multiChat", false, problems);

  let readReceiptEmoji = "EYES";
  if (merged.readReceiptEmoji !== undefined) {
    if (typeof merged.readReceiptEmoji === "string") readReceiptEmoji = merged.readReceiptEmoji;
    else problems.push("readReceiptEmoji 必须是字符串");
  }

  let dmMode: DmMode = "open";
  if (merged.dmMode !== undefined) {
    if (merged.dmMode === "open" || merged.dmMode === "allowlist") {
      dmMode = merged.dmMode;
    } else {
      problems.push('dmMode 必须是 "open" 或 "allowlist"');
      dmMode = "open";
    }
  } else if (merged.dmAllowlist !== undefined || merged.groupAllowlist !== undefined) {
    // 用户显式配了白名单但没写 dmMode：自动切换到 allowlist 模式
    dmMode = "allowlist";
  }

  const dmAllowlist = readStringArray(merged.dmAllowlist, "dmAllowlist", problems) ?? [];
  const groupAllowlist = readStringArray(merged.groupAllowlist, "groupAllowlist", problems) ?? [];
  if (dmMode === "allowlist" && dmAllowlist.length === 0 && groupAllowlist.length === 0) {
    problems.push("dmMode 为 allowlist 但 dmAllowlist 和 groupAllowlist 均为空，没有人能触达机器人");
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

  // 主动绑定的收件人。approverAllowlist 校验过非空，所以这里一定能取到值；
  // 名单里有多人时取第一个 —— 他们都是已授权的审批人，发给谁都不越权
  let operatorOpenId = approverAllowlist[0] ?? "";
  if (merged.operatorOpenId !== undefined) {
    if (typeof merged.operatorOpenId === "string") operatorOpenId = merged.operatorOpenId;
    else problems.push("operatorOpenId 必须是字符串");
  }

  // 群 chat_id 一律 oc_ 开头；ou_（open_id）不是会话 id，填错了会绑到一个
  // 永远收不到消息的目标上，只能在这里拦
  let bindTarget = "operator";
  if (merged.bindTarget !== undefined) {
    const t = merged.bindTarget;
    if (
      typeof t === "string" &&
      (t === "operator" || t === "none" || t === "code" || t.startsWith("oc_"))
    ) {
      bindTarget = t;
    } else {
      problems.push('bindTarget 必须是 "operator"、"none"、"code" 或以 oc_ 开头的会话 id');
    }
  }

  let transport: "direct" | "broker" = "direct";
  if (merged.transport !== undefined) {
    if (merged.transport === "direct" || merged.transport === "broker") transport = merged.transport;
    else problems.push('transport 必须是 "direct" 或 "broker"');
  }

  const brokerSocket =
    typeof merged.brokerSocket === "string"
      ? merged.brokerSocket
      : path.join(agentDir ?? cwd, "feishu-broker.sock");

  let approvalMode: ApprovalMode = "balanced";
  if (merged.approvalMode !== undefined) {
    if (
      merged.approvalMode === "balanced" ||
      merged.approvalMode === "strict" ||
      merged.approvalMode === "relaxed"
    ) {
      approvalMode = merged.approvalMode;
    } else {
      problems.push('approvalMode 必须是 "balanced"、"strict" 或 "relaxed"');
    }
  }

  // 正则在这里就编译一遍：让「配置写错了」在启动时报出来，
  // 而不是等某条命令恰好走到判定时才炸 —— 那时 fail-closed 会把一切判危险，
  // 现象是「突然什么都要审批」，根因极难定位
  const readPatterns = (v: unknown, key: string): string[] => {
    const arr = readStringArray(v, key, problems);
    if (arr === undefined) return [];
    for (const src of arr) {
      try {
        new RegExp(src);
      } catch (err) {
        problems.push(`${key} 里的 ${JSON.stringify(src)} 不是合法正则：${String(err)}`);
      }
    }
    return arr;
  };
  const denyPatterns = readPatterns(merged.denyPatterns, "denyPatterns");
  const allowPatterns = readPatterns(merged.allowPatterns, "allowPatterns");

  let pairingTtlMs = 600_000;
  if (merged.pairingTtlMs !== undefined) {
    const n = merged.pairingTtlMs;
    if (typeof n === "number" && Number.isInteger(n) && n > 0) pairingTtlMs = n;
    else problems.push("pairingTtlMs 必须是正整数（毫秒）");
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
    dmMode,
    dmAllowlist,
    groupAllowlist,
    approverAllowlist,
    operatorOpenId,
    bindTarget,
    pairingTtlMs,
    requireMention,
    multiChat,
    readReceiptEmoji,
    approvalMode,
    denyPatterns,
    allowPatterns,
    approvalTimeoutMs,
    repoRoot,
    transport,
    brokerSocket,
    autoStartBroker,
  };
}
