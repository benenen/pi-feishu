import { describeStatus } from "../herdr/agents.ts";
import type { AgentStatus, HerdrAgent, HerdrError } from "../herdr/types.ts";

/**
 * 飞书侧的 `/herdr` 命令：解析与渲染。**纯函数**，不碰网络、不碰状态，
 * 编排在 `herdr-service.ts`。
 *
 * 命令走本地处理，不进 pi 的 agent —— 这正是「同时向不同 agent 派活」的前提：
 * 若经 pi，所有任务都要排进同一个 agent 运行，并行无从谈起。
 */
export type HerdrCommand =
  | { kind: "list" }
  | { kind: "help" }
  | { kind: "status" }
  | { kind: "use"; target: string }
  | { kind: "run"; task: string }
  | { kind: "task"; target: string; task: string }
  | { kind: "new"; agentKind: string; task: string }
  | { kind: "read"; target: string }
  | { kind: "send"; target: string; text: string }
  | { kind: "keys"; target: string; keys: string[] }
  | { kind: "stop"; target: string }
  | { kind: "watch"; target: string }
  | { kind: "cancel"; id: string }
  | { kind: "invalid"; reason: string };

function firstToken(s: string): string {
  return s.split(/\s+/, 1)[0] ?? "";
}

function afterFirstToken(s: string): string {
  const at = s.search(/\s/);
  return at === -1 ? "" : s.slice(at).trim();
}

/**
 * 解析 `/herdr …`。不是这个前缀就返回 undefined（交给后面的正常消息路径）。
 *
 * 裸正文按「派活」处理 —— `/herdr 帮我看下 xxx` 是最顺手的写法。
 * 但已注册的子命令优先，所以 agent 名恰好叫 `list` 时用 `/herdr task list …`。
 */
export function parseHerdrCommand(text: string): HerdrCommand | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/herdr")) return undefined;
  const rest = trimmed.slice("/herdr".length);
  // "/herdrXXX" 不是命令，必须是词边界
  if (rest !== "" && !/^\s/.test(rest)) return undefined;

  const body = rest.trim();
  if (body === "") return { kind: "list" };

  const head = firstToken(body);
  const tail = afterFirstToken(body);
  switch (head.toLowerCase()) {
    case "list":
    case "ls":
      return { kind: "list" };
    case "help":
    case "?":
      return { kind: "help" };
    case "status":
      return { kind: "status" };
    case "use":
      return tail === "" ? { kind: "invalid", reason: "用法：/herdr use <agent>" } : { kind: "use", target: firstToken(tail) };
    case "read":
      return tail === "" ? { kind: "invalid", reason: "用法：/herdr read <agent>" } : { kind: "read", target: firstToken(tail) };
    case "stop":
      return tail === "" ? { kind: "invalid", reason: "用法：/herdr stop <agent>" } : { kind: "stop", target: firstToken(tail) };
    case "watch":
      return tail === "" ? { kind: "invalid", reason: "用法：/herdr watch <agent>" } : { kind: "watch", target: firstToken(tail) };
    case "cancel":
      return tail === "" ? { kind: "invalid", reason: "用法：/herdr cancel <watch-id>" } : { kind: "cancel", id: firstToken(tail) };
    case "task": {
      const target = firstToken(tail);
      const task = afterFirstToken(tail);
      if (target === "" || task === "") {
        return { kind: "invalid", reason: "用法：/herdr task <agent> <任务内容>" };
      }
      return { kind: "task", target, task };
    }
    case "new": {
      const agentKind = firstToken(tail);
      const task = afterFirstToken(tail);
      if (agentKind === "" || task === "") {
        return { kind: "invalid", reason: "用法：/herdr new <agent类型> <任务内容>" };
      }
      return { kind: "new", agentKind, task };
    }
    case "send": {
      const target = firstToken(tail);
      const rest2 = afterFirstToken(tail);
      if (target === "" || rest2 === "") {
        return { kind: "invalid", reason: "用法：/herdr send <agent> <要补的一句话>" };
      }
      return { kind: "send", target, text: rest2 };
    }
    case "keys": {
      const target = firstToken(tail);
      const keys = afterFirstToken(tail).split(/\s+/).filter((k) => k !== "");
      if (target === "" || keys.length === 0) {
        return { kind: "invalid", reason: "用法：/herdr keys <agent> <按键…>（如 ctrl+c、esc、enter）" };
      }
      return { kind: "keys", target, keys };
    }
    default:
      // 裸正文 = 派活
      return { kind: "run", task: body };
  }
}

export function renderHerdrHelp(): string {
  return [
    "**herdr 并行派活**",
    "",
    "- `/herdr` 或 `/herdr list` — 列出所有 agent（卡片上可直接选）",
    "- `/herdr use <agent>` — 选定这个对话默认派给谁",
    "- `/herdr run <任务>` — 派给选中的 agent（`/herdr <任务>` 同义）",
    "- `/herdr task <agent> <任务>` — 直接派给指定 agent，不改默认选择",
    "- `/herdr new <类型> <任务>` — 新开一个 agent（pi / claude / codex …）并派活",
    "- `/herdr status` — 这个对话正在等哪些任务",
    "- `/herdr read <agent>` — 现在读一段它的输出",
    "- `/herdr send <agent> <一句话>` — 往它里面补一句话",
    "- `/herdr keys <agent> <按键…>` — 送逻辑按键（ctrl+c / esc / enter），卡在选择框上时用",
    "- `/herdr watch <agent>` — 给一个已经在跑的 agent 补一个 watch",
    "- `/herdr stop <agent>` — 关掉它的 pane（终止它）",
    "- `/herdr cancel <id>` — 停止等待（不打断 agent 本身）",
    "",
    "任务完成后结果会自动回到这个对话。多个任务可以同时挂在不同的 agent 上并行跑。",
  ].join("\n");
}

export function agentLabel(agent: HerdrAgent): string {
  const name = agent.name ?? agent.paneId ?? "?";
  const kind = agent.kind ?? "?";
  return `${name}（${kind}）`;
}

export function renderAgentList(agents: HerdrAgent[], selected?: string): string {
  if (agents.length === 0) {
    return "herdr 里现在没有活动 agent。用 `/herdr new pi <任务>` 起一个。";
  }
  const lines = agents.map((a) => {
    const mark = selected !== undefined && a.name === selected ? " ✅ 当前" : "";
    const where = a.cwd !== undefined ? ` — ${a.cwd}` : "";
    return `- **${agentLabel(a)}** ${describeStatus(a.status)}${where}${mark}`;
  });
  const tail =
    selected === undefined
      ? "\n\n还没选默认 agent，发 `/herdr use <名字>` 选一个。"
      : `\n\n当前默认：**${selected}**。发 \`/herdr run <任务>\` 派活，或 \`/herdr task <别的agent> <任务>\` 换一个。`;
  return lines.join("\n") + tail;
}

export function renderSelected(target: string): string {
  return `已选定 **${target}**。接下来 \`/herdr run <任务>\` 都派给它。`;
}

export interface DispatchAck {
  agent: string;
  task: string;
  watchId: string;
}

export function renderDispatchAck(a: DispatchAck): string {
  return [
    `**已派给 ${a.agent}**（watch \`${a.watchId}\`）`,
    "",
    `> ${oneLine(a.task)}`,
    "",
    "完成后我会把结果发到这里。`/herdr status` 看进度，`/herdr cancel " + a.watchId + "` 停止等待。",
  ].join("\n");
}

export interface ResultReport {
  agent: string;
  status: AgentStatus;
  body: string;
  elapsedMs: number;
  timedOut: boolean;
  stalled: boolean;
  watchId: string;
}

export function renderResult(r: ResultReport): string {
  const head =
    r.timedOut
      ? `⏳ **${r.agent} 还在跑**（watch \`${r.watchId}\`，已等 ${formatDuration(r.elapsedMs)}）`
      : r.stalled
        ? `⚠️ **${r.agent} 没接住这句话**（没观测到活动，watch \`${r.watchId}\`）`
        : r.status === "blocked"
          ? `🔔 **${r.agent} 在等你回复**（${formatDuration(r.elapsedMs)}，watch \`${r.watchId}\`）`
          : `✅ **${r.agent} ${describeStatus(r.status)}**（${formatDuration(r.elapsedMs)}）`;
  const hint =
    r.status === "blocked" && !r.timedOut && !r.stalled
      ? `\n\n它卡在等你回话的界面上：先 \`/herdr keys ${r.agent} enter\` 或 \`/herdr send ${r.agent} <回答>\`；\n答不了就切到 herdr 面板直接操作。`
      : "";
  const body = r.body.trim() === "" ? "（没读到输出内容）" : r.body.trim();
  return `${head}\n\n${body}${hint}`;
}

export function renderWatchList(items: { id: string; agent: string; task: string; startedAgoMs: number }[]): string {
  if (items.length === 0) return "这个对话现在没有在等的任务。";
  return [
    "**正在等这些任务：**",
    ...items.map(
      (i) => `- \`${i.id}\` **${i.agent}**（${formatDuration(i.startedAgoMs)}）— ${oneLine(i.task)}`,
    ),
  ].join("\n");
}

export function renderHerdrError(prefix: string, error: HerdrError): string {
  return `${prefix}\n\n> ${error.code}：${error.message}`;
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const points = Array.from(flat);
  return points.length <= 80 ? flat : `${points.slice(0, 79).join("")}…`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

// ── 选 agent 的卡片 ────────────────────────────────────────────────

export const HERDR_CARD_KIND = "pi-feishu-herdr-select";

/** 一张卡片最多放几个 agent。超出的不在卡片上，用 /herdr use 手输 */
export const MAX_CARD_AGENTS = 20;
const BUTTONS_PER_ROW = 4;

/**
 * 选 agent 的卡片。按钮的 value 里带 `chatId`，把卡片绑死在发出去的那个对话 ——
 * 飞书 SDK 对 `card.action.trigger` **没有任何白名单过滤**，逐卡的会话绑定是
 * 仅次于操作者名单的那一层防线（与审批卡片同一套思路）。
 */
export function buildAgentPickerCard(
  id: string,
  chatId: string,
  agents: HerdrAgent[],
  selected?: string,
): object {
  const shown = agents.slice(0, MAX_CARD_AGENTS);
  const rows: object[] = [];
  for (let i = 0; i < shown.length; i += BUTTONS_PER_ROW) {
    rows.push({
      tag: "action",
      actions: shown.slice(i, i + BUTTONS_PER_ROW).map((a) => {
        const target = a.name ?? a.paneId ?? "?";
        return {
          tag: "button",
          text: { tag: "plain_text", content: `${target}·${shortStatus(a.status)}` },
          type: selected !== undefined && a.name === selected ? "primary" : "default",
          value: { kind: HERDR_CARD_KIND, id, chatId, target },
        };
      }),
    });
  }
  const elements: object[] = [
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content:
          selected === undefined
            ? "选一个 agent 作为本对话的默认派活对象。"
            : `当前默认：**${selected}**。点别的可以换。`,
      },
    },
    ...rows,
  ];
  if (agents.length > shown.length) {
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: `还有 ${agents.length - shown.length} 个没放上卡片，用 \`/herdr use <名字>\` 选。`,
      },
    });
  }
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: "blue", title: { tag: "plain_text", content: "选择 herdr agent" } },
    elements,
  };
}

function shortStatus(status: AgentStatus): string {
  if (status === "working") return "忙";
  if (status === "blocked") return "等输入";
  if (status === "done") return "完成";
  if (status === "idle") return "空闲";
  return "未知";
}

export interface HerdrCardAction {
  id: string;
  chatId: string;
  target: string;
}

export function parseHerdrCardAction(value: unknown): HerdrCardAction | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (v.kind !== HERDR_CARD_KIND) return undefined;
  if (typeof v.id !== "string" || typeof v.chatId !== "string" || typeof v.target !== "string") {
    return undefined;
  }
  if (v.target === "") return undefined;
  return { id: v.id, chatId: v.chatId, target: v.target };
}
