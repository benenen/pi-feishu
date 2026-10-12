import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHerdrCli, defaultSpawn, resolveHerdrBin, type HerdrCli } from "./cli.ts";
import {
  describeStatus,
  getAgent,
  listAgents,
  probeVersion,
  promptAgent,
  sendKeys,
  startAgent,
  stopAgent,
} from "./agents.ts";
import { harvestResult } from "./harvest.ts";
import { promptAndWatch, watchUntilSettled } from "./watch.ts";
import type { HerdrAgent, Result } from "./types.ts";

/**
 * herdr 的 pi 工具层。
 *
 * 这一层只做两件事：把 herdr 的能力包成工具给模型，以及把 `Result<T>`
 * 翻成 pi 的工具返回。**所有编排逻辑都在 `herdr/*.ts` 里**（无 pi 依赖、
 * 可离线测试），飞书接入层调的是同一批函数 —— 两条入口共用一份实现。
 *
 * factory 里绝不启动任何后台资源；`herdr` 客户端在每次调用时才构造，
 * 这样 `HERDR_BIN`/`PATH` 改了立刻生效，也不再为一次没用过的工具探活。
 */

/** 每次调用现构造：解析 bin 是纯字符串操作，不 spawn 任何进程 */
function client(): HerdrCli {
  return createHerdrCli({
    bin: resolveHerdrBin(process.env),
    spawn: defaultSpawn,
    env: process.env,
  });
}

type ToolResult = {
  content: { type: "text"; text: string }[];
  details: unknown;
  isError?: boolean;
};

/** 把 `Result<T>` 归一成 pi 的工具返回。错误带 isError，模型能看出这是失败 */
export function unwrap<T>(r: Result<T>, format?: (data: T) => string): ToolResult {
  if (r.ok) {
    return {
      content: [{ type: "text", text: format ? format(r.data) : JSON.stringify(r.data, null, 2) }],
      details: r.data,
    };
  }
  return {
      content: [{ type: "text", text: `herdr 调用失败（${r.error.code}）：${r.error.message}${r.error.code === "NOT_FOUND" ? "\n请先调用 herdr_list_agents，复制输出中的 target。工作区标签、目录名和终端标题不是 agent 名；不要据此猜 target，也不要因为目标不存在就自动新建 agent。" : ""}` }],
    details: { error: r.error },
    isError: true,
  };
}

export function formatAgent(a: HerdrAgent): string {
  const name = a.name ?? a.paneId ?? "?";
  const kind = a.kind ?? "?";
  const bits = [`target=${JSON.stringify(name)}（${kind}）`, describeStatus(a.status)];
  if (a.interactiveReady === false) bits.push("未就绪");
  if (a.title !== undefined && a.title !== "") bits.push(a.title);
  if (a.cwd !== undefined) bits.push(a.cwd);
  return bits.join(" · ");
}

function formatAgents(agents: HerdrAgent[]): string {
  if (agents.length === 0) return "herdr 里现在没有活动 agent。";
  return agents.map((a) => `- ${formatAgent(a)}`).join("\n");
}

// 参数用手写 JSON Schema 而不是 typebox：typebox 只存在于 pi 自己的
// node_modules 里，从本仓库 import 运行期直接 ERR_MODULE_NOT_FOUND（实测过）。
// pi 把 parameters 原样透给模型、不做 TypeBox 校验，普通 JSON Schema 就够。

const targetParam = {
  type: "string",
  description: "必须原样复制 herdr_list_agents 输出中的 target：注册的 agent 名或 pane id（如 w1:p1）。工作区标签、目录名和终端标题不能作为 target。",
};

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "herdr_list_agents",
    label: "列出 herdr agent",
    description:
      "列出本机 herdr 里所有活动的 coding agent（pi / claude / codex …）及其状态、工作目录。" +
      "派活给别的 agent 之前先用它拿目标名。herdr 不可用时返回明确错误，不阻塞。",
    promptSnippet: "herdr_list_agents() — 本机 herdr 里有哪些 agent、在干什么",
    promptGuidelines: [
      "herdr 派活默认复用已经启动的 agent：先列出，按工作目录、任务和空闲状态选择最合适的现有 agent。只有用户明确要求新启动一个 agent 才能调用 herdr_start_agent；没有合适的现有 agent 时说明原因，不能自行新建。",
      "所有 herdr 工具的 target 必须原样复制 herdr_list_agents 输出中的 target 字段。没有注册名称的 agent 用 pane id；工作区标签（例如 aiclass）、目录名和标题只是上下文，不是目标标识。NOT_FOUND 时重新列出，不能猜目标或自动创建 agent。",
    ],
    parameters: { type: "object", properties: {} } as never,
    async execute() {
      const r = await listAgents(client());
      return unwrap(r, formatAgents);
    },
  });

  pi.registerTool({
    name: "herdr_start_agent",
    label: "在 herdr 里开一个 agent",
    description:
      "在 herdr 里新开一个 coding agent（默认 kind=pi）。在 herdr 面板里跑时是往旁边 split 一个兄弟 pane；" +
      "不在 herdr 里跑时开一个新 workspace。仅在用户明确要求新建 agent 时使用；默认目录为用户主目录 ~，不继承当前工作目录。默认不抢焦点。",
    promptSnippet: "herdr_start_agent(name, kind?, cwd?) — 起一个独立 agent 干长活",
    promptGuidelines: ["新建 herdr agent 必须由用户明确提出；cwd 用用户指定的目录，未指定时省略 cwd（启动逻辑默认用户主目录），不能主动填当前仓库。"],
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "唯一名字，匹配 [a-z][a-z0-9_-]{0,31}" },
        kind: { type: "string", description: "agent 种类，默认 pi。可用 herdr_list_agents 或 herdr agent 查列表" },
        cwd: { type: "string", description: "用户明确指定的工作目录；未指定时默认用户主目录 ~，不继承当前进程目录" },
        direction: { type: "string", enum: ["right", "down"], description: "在 herdr 里 split 的方向，默认 right" },
      },
      required: ["name"],
    } as never,
    async execute(_id, params, signal) {
      const p = params as { name: string; kind?: string; cwd?: string; direction?: "right" | "down" };
      const r = await startAgent(client(), {
        name: p.name,
        kind: p.kind,
        cwd: p.cwd,
        direction: p.direction,
        signal,
      });
      return unwrap(r, formatAgent);
    },
  });

  pi.registerTool({
    name: "herdr_send_prompt",
    label: "派活给 herdr agent",
    description:
      "把一句话送给某个 herdr agent，默认等它落地（idle/done/blocked）并返回它的答复。" +
      "这是「派活 → 加 watch → 取结果」的一体化调用；任务很久时用 wait=false 只投递，" +
      "之后再用 herdr_wait_agent / herdr_read_agent 取。",
    promptSnippet: "herdr_send_prompt(target, text, wait?) — 让别的 agent 干活并取回答复",
    parameters: {
      type: "object",
      properties: {
        target: targetParam,
        text: { type: "string", description: "要发给 agent 的完整指令" },
        wait: { type: "boolean", description: "是否等它落地再返回，默认 true" },
      },
      required: ["target", "text"],
    } as never,
    async execute(_id, params, signal) {
      const p = params as { target: string; text: string; wait?: boolean };
      const cli = client();
      if (p.wait === false) {
        // 只投递：拿到「已送出」就返回，结果之后用 wait/read 取
        const sent = await promptAgent(cli, p.target, p.text, { signal });
        return unwrap(sent, (a) => `已投递给 ${p.target}${a ? `（当前状态：${describeStatus(a.status)}）` : ""}`);
      }
      const r = await promptAndWatch(cli, p.target, p.text, { signal });
      if (!r.ok) return unwrap(r);
      const reported = r.data;
      const harvested = await harvestResult(cli, p.target, reported.agent);
      const body = harvested.ok ? harvested.data.text : "";
      const header = `${p.target} ${describeStatus(reported.status)}${
        reported.timedOut ? "（等到上限仍在跑，下面是当前输出）" : ""
      }${reported.stalled ? "（没观测到活动，prompt 可能没送到）" : ""}`;
      return {
        content: [{ type: "text", text: body === "" ? header : `${header}\n\n${body}` }],
        details: reported,
      };
    },
  });

  pi.registerTool({
    name: "herdr_read_agent",
    label: "读 herdr agent 的输出",
    description: "读某个 herdr agent 面板最近若干行的输出。pi agent 会优先抽它的会话文件，输出更干净。",
    promptSnippet: "herdr_read_agent(target, lines?) — 看它现在写到哪了",
    parameters: {
      type: "object",
      properties: {
        target: targetParam,
        lines: { type: "number", description: "读多少行，默认 120" },
      },
      required: ["target"],
    } as never,
    async execute(_id, params, signal) {
      const p = params as { target: string; lines?: number };
      const cli = client();
      const agent = await getAgent(cli, p.target);
      const r = await harvestResult(cli, p.target, agent.ok ? agent.data : undefined, {
        lines: p.lines,
        signal,
      });
      return unwrap(r, (d) => d.text);
    },
  });

  pi.registerTool({
    name: "herdr_wait_agent",
    label: "等 herdr agent 落地",
    description:
      "等某个已经在跑的 herdr agent 落到 idle/done/blocked。已经落地就立刻返回。" +
      "到时限仍没落地时返回当前状态（不报错），别把它当成完成。",
    promptSnippet: "herdr_wait_agent(target, timeoutMinutes?) — 等它干完",
    parameters: {
      type: "object",
      properties: {
        target: targetParam,
        timeoutMinutes: { type: "number", description: "总共等多少分钟，默认 20" },
      },
      required: ["target"],
    } as never,
    async execute(_id, params, signal) {
      const p = params as { target: string; timeoutMinutes?: number };
      const maxWaitMs = Math.max(1, (p.timeoutMinutes ?? 20) * 60_000);
      const r = await watchUntilSettled(client(), p.target, { maxWaitMs, signal });
      return unwrap(r, (d) =>
        `${p.target} ${describeStatus(d.status)}${d.timedOut ? "（等超时，仍在运行）" : ""}`,
      );
    },
  });

  pi.registerTool({
    name: "herdr_stop_agent",
    label: "关掉 herdr agent",
    description: "关闭某个 herdr agent 所在的 pane，等于终止这个 agent。危险操作，只在确认它没用了之后调。",
    promptSnippet: "herdr_stop_agent(target) — 终止一个 agent",
    parameters: {
      type: "object",
      properties: { target: targetParam },
      required: ["target"],
    } as never,
    async execute(_id, params) {
      const p = params as { target: string };
      const r = await stopAgent(client(), p.target);
      return unwrap(r, (paneId) => `已关闭 ${p.target}（pane ${paneId}）`);
    },
  });

  pi.registerTool({
    name: "herdr_send_keys",
    label: "给 herdr agent 发按键",
    description:
      "给某个 herdr agent 发逻辑按键，比如 ctrl+c 打断、esc 退出、enter 确认。" +
      "审批弹窗里选不了的时候用它，比往 pane 里打字安全 —— herdr 会先整体校验按键。",
    promptSnippet: "herdr_send_keys(target, keys) — ctrl+c / esc / enter",
    parameters: {
      type: "object",
      properties: {
        target: targetParam,
        keys: {
          type: "array",
          items: { type: "string" },
          description: "逻辑按键名，如 ctrl+c、esc、enter、up",
        },
      },
      required: ["target", "keys"],
    } as never,
    async execute(_id, params) {
      const p = params as { target: string; keys: string[] };
      const r = await sendKeys(client(), p.target, p.keys);
      return unwrap(r, () => `已发送按键 ${p.keys.join(" ")}`);
    },
  });

  pi.registerTool({
    name: "herdr_version",
    label: "查 herdr 版本",
    description: "查本机 herdr 的版本，顺便确认它可用（不可用会明确报错）。",
    parameters: { type: "object", properties: {} } as never,
    async execute() {
      const r = await probeVersion(client());
      return r === undefined
        ? {
            content: [{ type: "text" as const, text: "找不到可用的 herdr（检查 PATH 或 HERDR_BIN）" }],
            details: undefined,
            isError: true,
          }
        : { content: [{ type: "text" as const, text: r }], details: { version: r } };
    },
  });
}
