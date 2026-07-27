import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ConfigError, loadConfig, type Config } from "./config.ts";
import { FeishuGateway } from "./feishu.ts";
import { Bridge, decideDelivery, parseControlCommand, shouldAccept } from "./bridge.ts";
import type { Asker } from "./approval.ts";

function readJsonIfExists(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function resolveConfig(cwd: string): Config {
  return loadConfig({
    files: [
      readJsonIfExists(path.join(getAgentDir(), "feishu.json")),
      readJsonIfExists(path.join(cwd, ".pi", "feishu.json")),
    ],
    env: process.env,
    cwd,
  });
}

export default function (pi: ExtensionAPI) {
  // 注意：factory 里绝不启动任何后台资源，只声明。
  let gateway: FeishuGateway | undefined;
  let bridge: Bridge | undefined;
  let config: Config | undefined;

  const log = (msg: string) => console.error(`[pi-feishu] ${msg}`);

  async function start(cwd: string, notify: (msg: string) => void): Promise<void> {
    if (gateway) {
      notify("飞书桥接已在运行");
      return;
    }
    // 用局部常量承接，避免 `Config | undefined` 传进构造函数导致类型报错
    let cfg: Config;
    try {
      cfg = resolveConfig(cwd);
    } catch (err) {
      notify(err instanceof ConfigError ? err.message : `配置加载失败：${String(err)}`);
      return;
    }
    config = cfg;

    const gw = new FeishuGateway(cfg, log);
    const br = new Bridge(cfg, gw, log);

    gw.onMessage((msg) => {
      void (async () => {
        try {
          if (!shouldAccept(gw, msg.chatId)) {
            // 必须显式指定收件会话，否则会发到已绑定的那个会话去
            await gw.sendText("该 pi 会话已绑定到其他对话。", msg.chatId);
            return;
          }
          if (gw.boundChatId === undefined) gw.bind(msg.chatId);

          const control = parseControlCommand(msg.text);
          if (control) {
            if (control.kind === "stop") await stop((m) => void gw.sendText(m));
            else if (control.kind === "status") {
              await gw.sendText(
                `运行中，绑定会话：${gw.boundChatId ?? "（尚未绑定）"}，审批模式：${config?.approvalMode}`,
              );
            } else {
              await gw.sendText("可用命令：/feishu status、/feishu stop。start 只能从终端发起。");
            }
            return;
          }

          const content = await br.toPromptContent(msg);
          const { text, deliverAs } = decideDelivery(content, br.isStreaming);
          if (text === "") return;
          await pi.sendUserMessage(text, deliverAs ? { deliverAs } : undefined);
        } catch (err) {
          log(`处理入站消息失败：${String(err)}`);
        }
      })();
    });

    await gw.connect();
    gateway = gw;
    bridge = br;
    notify("飞书桥接已启动，等待消息绑定会话");
  }

  async function stop(notify: (msg: string) => void): Promise<void> {
    const gw = gateway;
    gateway = undefined;
    bridge = undefined;
    if (!gw) {
      notify("飞书桥接未在运行");
      return;
    }
    await gw.disconnect();
    notify("飞书桥接已停止");
  }

  pi.registerCommand("feishu", {
    description: "控制飞书桥接：start / stop / status",
    handler: async (args, ctx) => {
      const notify = (msg: string) => ctx.ui.notify(msg, "info");
      const sub = args.trim() || "status";
      if (sub === "start") await start(ctx.cwd, notify);
      else if (sub === "stop") await stop(notify);
      else if (sub === "status") {
        notify(
          gateway
            ? `运行中，绑定会话：${gateway.boundChatId ?? "（尚未绑定）"}，审批模式：${config?.approvalMode}`
            : "未运行。用 /feishu start 启动。",
        );
      } else notify(`未知子命令：${sub}。可用：start / stop / status`);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    let cfg: Config | undefined;
    try {
      cfg = resolveConfig(ctx.cwd);
    } catch {
      return; // 未配置就静默不启动
    }
    if (cfg.autoStart) await start(ctx.cwd, (msg) => log(msg));
  });

  pi.on("session_shutdown", async () => {
    await stop(() => {});
  });

  // 会话被替换前先断开，未决审批在 disconnect 里一律拒绝
  pi.on("session_before_switch", async () => {
    await stop(() => {});
  });
  pi.on("session_before_fork", async () => {
    await stop(() => {});
  });

  pi.on("input", (event) => {
    bridge?.onUserPrompt(event.text, event.source === "extension" ? "feishu" : "interactive");
  });

  pi.on("agent_start", () => bridge?.startTurn());

  pi.on("message_update", (event) => {
    const e = event.assistantMessageEvent;
    if (e.type === "text_delta") bridge?.onTextDelta(e.delta);
  });

  pi.on("message_end", (event) => {
    const usage = (event.message as { usage?: { totalTokens?: number } }).usage;
    if (usage?.totalTokens) bridge?.addTokens(usage.totalTokens);
  });

  pi.on("tool_execution_start", (event) => {
    // ToolExecutionStartEvent 带 args，工具行才能显示具体命令/路径
    const args = (event.args ?? {}) as Record<string, unknown>;
    bridge?.onToolStart(event.toolCallId, event.toolName, args);
  });

  pi.on("tool_execution_end", (event) => {
    bridge?.onToolEnd(event.toolCallId, event.isError);
  });

  pi.on("agent_end", async () => {
    await bridge?.endTurn();
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!bridge) return undefined;

    const tuiAsker: Asker | undefined = ctx.hasUI
      ? async (req, signal) => {
          const ok = await ctx.ui.confirm(
            `⚠️ 需要审批：${req.toolName}`,
            JSON.stringify(req.input).slice(0, 500),
            { signal },
          );
          return { allow: ok === true, reason: ok === true ? "终端批准" : "终端拒绝" };
        }
      : undefined;

    return await bridge.gateToolCall(event.toolName, event.input, tuiAsker);
  });
}
