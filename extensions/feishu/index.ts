import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ConfigError, loadConfig, readConfigFile, type Config } from "./config.ts";
import { createLogger } from "./log.ts";
import { FeishuGateway } from "./feishu.ts";
import {
  announceAndBind,
  bindToChat,
  Bridge,
  decideDelivery,
  parseControlCommand,
  shouldAccept,
} from "./bridge.ts";
import { renderStatus } from "./renderer.ts";
import type { Asker } from "./approval.ts";

/** 会话切换时等待断开的上限，防止飞书 API 挂住把 /new 一起冻住 */
const SHUTDOWN_TIMEOUT_MS = 5_000;

function resolveConfig(cwd: string): Config {
  return loadConfig({
    files: [
      readConfigFile(path.join(getAgentDir(), "feishu.json")),
      readConfigFile(path.join(cwd, ".pi", "feishu.json")),
    ],
    env: process.env,
    cwd,
  });
}

/** 超时就放弃等待 —— 宁可留个半开的连接，也不能把会话切换冻住 */
async function withTimeout(work: Promise<void>, ms: number, onTimeout: () => void): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    work.then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), ms);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (timedOut) onTimeout();
}

export default function (pi: ExtensionAPI) {
  // 注意：factory 里绝不启动任何后台资源，只声明。
  let gateway: FeishuGateway | undefined;
  let bridge: Bridge | undefined;
  let config: Config | undefined;

  // ExtensionContext 的属性是惰性 getter，存下引用晚点读拿到的仍是当前的 UI；
  // 每个 handler 都带 ctx，这里只在生命周期入口刷新就够了
  let ctxRef: ExtensionContext | undefined;
  const log = createLogger(() => ctxRef);

  // gateway 只在 connect() 返回后才赋值，光靠它挡不住在途的第二次 start：
  // autoStart 撞上手动 /feishu start，会建出两条 WS 连接抢同一批消息 ——
  // 正是 autoStart 默认关闭想避免的那件事。
  let starting: Promise<void> | undefined;

  async function start(cwd: string, notify: (msg: string) => void): Promise<void> {
    if (starting) {
      notify("飞书桥接正在启动中");
      return starting;
    }
    if (gateway) {
      notify("飞书桥接已在运行");
      return;
    }
    starting = startInner(cwd, notify).finally(() => {
      starting = undefined;
    });
    return starting;
  }

  async function startInner(cwd: string, notify: (msg: string) => void): Promise<void> {
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
          log(`收到消息：chatId=${msg.chatId} senderId=${msg.senderId}`);
          if (gw.boundChatId === undefined) gw.bind(msg.chatId);

          const control = parseControlCommand(msg.text);
          if (control) {
            if (control.kind === "stop") await stop((m) => void gw.sendText(m));
            else if (control.kind === "unbind") {
              // 先回执再解绑：解绑后 sendText 没有默认收件方，必须显式指定本会话
              await gw.sendText("已解绑，下一条消息会重新绑定会话。", msg.chatId);
              gw.unbind();
            } else if (control.kind === "status") {
              await gw.sendText(await statusText());
            } else {
              await gw.sendText("可用命令：/feishu status、/feishu unbind、/feishu stop。start 只能从终端发起。");
            }
            return;
          }

          const content = await br.toPromptContent(msg);
          const { text, deliverAs } = decideDelivery(content, br.isStreaming);
          if (text === "") return;
          await pi.sendUserMessage(text, deliverAs ? { deliverAs } : undefined);
        } catch (err) {
          log(`处理入站消息失败：${String(err)}`, "error");
        }
      })();
    });

    try {
      await gw.connect();
    } catch (err) {
      // 凭据错、网络不通是新用户最常撞的两件事，必须给出本地化提示，
      // 而不是让异常冒到 pi 的通用错误通道里
      notify(`飞书连接失败：${String(err)}`);
      return;
    }
    gateway = gw;
    bridge = br;

    // 按 bindTarget 决定绑谁。绑不上都不是错误 —— 退回等第一条入站消息即可
    const greeting = `pi 会话已就绪（${cwd}），直接发消息即可。`;
    let boundTo: string | undefined;
    if (cfg.bindTarget === "operator") {
      if (await announceAndBind(gw, cfg.operatorOpenId, greeting, log)) boundTo = "与操作员的私聊";
    } else if (cfg.bindTarget.startsWith("oc_")) {
      if (await bindToChat(gw, cfg.bindTarget, greeting, log)) boundTo = cfg.bindTarget;
    }
    // "none"：什么都不做，群里 @ 或私聊第一条消息来绑定
    notify(
      boundTo ? `飞书桥接已启动，已绑定 ${boundTo}` : "飞书桥接已启动，等待消息绑定会话",
    );
  }

  /** 终端与飞书两侧共用同一份状态文案，避免两边说法不一致 */
  async function statusText(): Promise<string> {
    return renderStatus({
      running: gateway !== undefined,
      config,
      boundChatId: gateway?.boundChatId,
      boundChatName: await gateway?.describeBoundChat(),
      streaming: bridge?.isStreaming,
      turnApproved: bridge?.turnApproved,
    });
  }

  async function stop(notify: (msg: string) => void): Promise<void> {
    const gw = gateway;
    gateway = undefined;
    bridge = undefined;
    if (!gw) {
      notify("飞书桥接未在运行");
      return;
    }
    // 先回执再断开：飞书侧的 notify 走的正是 gw.sendText，
    // disconnect 会把 channel 清掉，之后再发就是静默丢弃
    notify("飞书桥接已停止");
    await gw.disconnect();
  }

  pi.registerCommand("feishu", {
    description: "控制飞书桥接：start / stop / status / unbind",
    handler: async (args, ctx) => {
      ctxRef = ctx;
      const notify = (msg: string) => ctx.ui.notify(msg, "info");
      const sub = args.trim() || "status";
      if (sub === "start") await start(ctx.cwd, notify);
      else if (sub === "stop") await stop(notify);
      else if (sub === "unbind") {
        if (!gateway) notify("飞书桥接未在运行");
        else {
          gateway.unbind();
          notify("已解绑，下一条消息会重新绑定会话");
        }
      }
      else if (sub === "status") notify(await statusText()); else notify(`未知子命令：${sub}。可用：start / stop / status / unbind`);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx;
    let cfg: Config | undefined;
    try {
      cfg = resolveConfig(ctx.cwd);
    } catch {
      return; // 未配置就静默不启动
    }
    if (cfg.autoStart) await start(ctx.cwd, (msg) => log(msg));
  });

  pi.on("session_shutdown", async () => {
    await withTimeout(stop(() => {}), SHUTDOWN_TIMEOUT_MS, () =>
      log("断开飞书超时，放弃等待", "warning"),
    );
  });

  // 会话被替换前先断开，未决审批在 disconnect 里一律拒绝
  // 会话切换/派生前必须断开，但不能无限等：disconnect 会逐张收尾审批卡片，
  // 飞书 API 一旦挂住（不是拒绝，是不返回），/new 就跟着永久冻住
  const stopForReplacement = async () => {
    await withTimeout(stop(() => {}), SHUTDOWN_TIMEOUT_MS, () =>
      log("会话切换时断开飞书超时，放弃等待", "warning"),
    );
  };
  pi.on("session_before_switch", stopForReplacement);
  pi.on("session_before_fork", stopForReplacement);

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
