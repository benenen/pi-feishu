import path from "node:path";
import { randomInt } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ConfigError, loadConfig, readConfigFile, type Config } from "./config.ts";
import { createLogger } from "./log.ts";
import { FeishuGateway } from "./feishu.ts";
import net from "node:net";
import { spawn } from "node:child_process";
import { BrokerGateway } from "./broker-gateway.ts";
import { ensureBroker } from "./broker/ensure.ts";
import {
  announceAndBind,
  bindToChat,
  Bridge,
  decideDelivery,
  parseControlCommand,
  shouldAccept,
} from "./bridge.ts";
import { renderStatus, renderUnbindNotice } from "./renderer.ts";
import { createPairing, type Pairing } from "./pairing.ts";
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
    agentDir: getAgentDir(),
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
  // GatewayLike 是 Bridge 及其下游看到的耦合面，但 index.ts 这里还要调
  // unbind/describeBoundChat/connect/disconnect 等两个具体类都有、但 GatewayLike
  // 没声明的方法，所以用两个具体类的联合类型而不是 GatewayLike
  let gateway: FeishuGateway | BrokerGateway | undefined;
  let bridge: Bridge | undefined;
  let config: Config | undefined;

  // ExtensionContext 的属性是惰性 getter，存下引用晚点读拿到的仍是当前的 UI；
  // 每个 handler 都带 ctx，这里只在生命周期入口刷新就够了
  let ctxRef: ExtensionContext | undefined;
  const log = createLogger(() => ctxRef);
  let pairing: Pairing | undefined;

  /** 签发配对码并只在终端显示 —— 发进飞书就等于把门钥匙挂门上了 */
  function issuePairingCode(notify: (msg: string) => void): void {
    if (!pairing) return;
    const code = pairing.issue();
    const minutes = Math.round((config?.pairingTtlMs ?? 600_000) / 60_000);
    notify(
      `飞书桥接已启动，等待配对。\n在要绑定的飞书对话里发送这串配对码（${minutes} 分钟内有效）：\n\n    ${code}\n`,
    );
  }

  /**
   * broker 档的配对码由 broker 签发，这里只是转发请求、把结果显示在终端。
   * broker 调用不自我包含异常，rejection 必须在这里兜住，不能逃进 pi 的事件循环。
   */
  async function requestBrokerPairingCode(
    gw: BrokerGateway,
    notify: (msg: string) => void,
    prefix = "",
  ): Promise<void> {
    try {
      const code = await gw.requestPairingCode();
      notify(`${prefix}在要绑定的对话里发送配对码：\n\n    ${code}\n`);
    } catch (err) {
      notify(`${prefix}获取配对码失败：${String(err)}`);
    }
  }

  /**
   * broker 档下，连接前先确保 broker 在跑。
   *
   * 探活用连 socket 而不是查 pid：pid 会被复用，「能连上」才是我们真正关心的。
   * 拉起用 detached + unref —— broker 必须活得比拉起它的这个 pi 会话久，
   * 否则会话一退它就跟着死，别的会话跟着失联。
   */
  async function ensureBrokerRunning(cfg: Config): Promise<boolean> {
    const result = await ensureBroker(
      {
        probe: () =>
          new Promise<boolean>((resolve) => {
            const sock = net.createConnection(cfg.brokerSocket);
            let settled = false;
            const done = (ok: boolean) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              sock.destroy();
              resolve(ok);
            };
            const timer = setTimeout(() => done(false), 500);
            sock.once("connect", () => done(true));
            sock.once("error", () => done(false));
          }),
        spawn: () => {
          const entry = path.join(cfg.repoRoot, "bin", "broker.ts");
          const child = spawn(process.execPath, [entry], {
            cwd: cfg.repoRoot,
            detached: true,
            stdio: "ignore",
          });
          child.unref();
          return { pid: child.pid };
        },
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        now: () => Date.now(),
        timeoutMs: 30_000,
        pollMs: 250,
      },
      (msg) => log(msg),
    );
    return result !== "failed";
  }

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

    // GatewayLike 是唯一的耦合面，两种传输在这里分叉，
    // Bridge 及其下游（renderer / risk / approval）完全无感
    const gw = cfg.transport === "broker" ? new BrokerGateway(log) : new FeishuGateway(cfg, log);
    const br = new Bridge(cfg, gw, log);

    gw.onMessage((msg) => {
      void (async () => {
        try {
          // 待配对时，未绑定状态下只认配对码 —— 任何其他消息都不该绑上来，
          // 否则「先握手再绑定」就形同虚设。
          // broker 档下这个分支恒为假，是安全的死代码：broker 模式从不创建本地
          // pairing（配对在 broker 侧靠 registry.matchCode + bound 帧完成），
          // 且 broker 对未绑定会话的消息本就不会转发 message 帧过来（见
          // broker/server.ts 的 deliver()），所以这里永远走不到。
          if (gw.boundChatId === undefined && pairing?.pending === true) {
            if (pairing.match(msg.text)) {
              gw.bind(msg.chatId);
              log(`配对成功，已绑定 ${msg.chatId}`);
              await gw.sendText("配对成功，本对话已绑定该 pi 会话。", msg.chatId);
            } else {
              // 不回显配对码，只提示需要配对
              await gw.sendText("该 pi 会话尚未配对，请发送终端上显示的配对码。", msg.chatId);
            }
            return;
          }

          if (!shouldAccept(gw, msg.chatId, cfg.multiChat)) {
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
              // 先回执再解绑：解绑后 sendText 没有默认收件方，必须显式指定本会话。
              // broker 档下解绑不签发新码，回执得说清楚下一步，否则用户会卡在
              // 飞书里等一个永远不会发生的「下一条消息自动绑定」
              await gw.sendText(
                renderUnbindNotice(gw instanceof BrokerGateway ? "broker" : "direct"),
                msg.chatId,
              );
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
          // 登记来源，agent_start 时按 FIFO 认领 —— pi 的事件不带触发者信息。
          // steer 是插进当前回合、不开新回合的，入队会让之后每个回合都错位一个
          if (deliverAs !== "steer") br.noteInboundOrigin(msg.chatId);
          await pi.sendUserMessage(text, deliverAs ? { deliverAs } : undefined);
        } catch (err) {
          log(`处理入站消息失败：${String(err)}`, "error");
        }
      })();
    });

    // 配了 broker 档就自动保证它在跑 —— 用户不该为了用飞书先去手动起个进程。
    // 关掉 autoStartBroker 表示「由 supervisor 之类托管」，此时会话不去干预
    if (gw instanceof BrokerGateway && cfg.autoStartBroker) {
      if (!(await ensureBrokerRunning(cfg))) {
        notify(`broker 未能就绪，无法启动飞书桥接。看日志：node scripts/brokerctl.js logs`);
        return;
      }
    }

    try {
      if (gw instanceof BrokerGateway) await gw.connect(cfg.brokerSocket, path.basename(cwd), cwd);
      else await gw.connect();
    } catch (err) {
      // 凭据错、网络不通是新用户最常撞的两件事，必须给出本地化提示，
      // 而不是让异常冒到 pi 的通用错误通道里
      notify(`飞书连接失败：${String(err)}`);
      return;
    }
    gateway = gw;
    bridge = br;

    // broker 档下绑定权在 broker 手里：bindTarget 的 operator/oc_xxx/none 三档
    // 都不生效，统一走「向 broker 要配对码，终端显示」这条路。broker 服务端配对
    // 成功时自己会往那个飞书对话发确认文案，这里不能再发一遍
    if (gw instanceof BrokerGateway) {
      await requestBrokerPairingCode(gw, notify, "飞书桥接已启动（broker 模式）。");
      return;
    }

    // 按 bindTarget 决定绑谁。绑不上都不是错误 —— 退回等第一条入站消息即可
    const greeting = `pi 会话已就绪（${cwd}），直接发消息即可。`;
    let boundTo: string | undefined;
    if (cfg.bindTarget === "operator") {
      if (await announceAndBind(gw, cfg.operatorOpenId, greeting, log)) boundTo = "与操作员的私聊";
    } else if (cfg.bindTarget.startsWith("oc_")) {
      if (await bindToChat(gw, cfg.bindTarget, greeting, log)) boundTo = cfg.bindTarget;
    }

    if (boundTo) {
      notify(`飞书桥接已启动，已绑定 ${boundTo}`);
      return;
    }
    // 没绑上：code 档签发配对码，其余仍是「第一条消息绑定」
    if (cfg.bindTarget === "code") {
      pairing = createPairing(cfg.pairingTtlMs, randomInt);
      issuePairingCode(notify);
      return;
    }
    notify("飞书桥接已启动，等待消息绑定会话");
  }

  /** 终端与飞书两侧共用同一份状态文案，避免两边说法不一致 */
  async function statusText(): Promise<string> {
    return renderStatus({
      running: gateway !== undefined,
      config,
      boundChatId: gateway?.boundChatId,
      boundChatName: await gateway?.describeBoundChat(),
      pairingPending: pairing?.pending,
      streaming: bridge?.isStreaming,
      turnApproved: bridge?.turnApproved,
      // gateway 存在只说明「启动过」，broker 掉了它照样是 truthy
      brokerConnected: gateway instanceof BrokerGateway ? gateway.connected : undefined,
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
    pairing?.cancel();
    pairing = undefined;
    notify("飞书桥接已停止");
    await gw.disconnect();
  }

  pi.registerCommand("feishu", {
    description: "控制飞书桥接：start / stop / status / pair / unbind",
    handler: async (args, ctx) => {
      ctxRef = ctx;
      const notify = (msg: string) => ctx.ui.notify(msg, "info");
      const sub = args.trim() || "status";
      if (sub === "start") await start(ctx.cwd, notify);
      else if (sub === "stop") await stop(notify);
      else if (sub === "pair") {
        if (!gateway) notify("飞书桥接未在运行");
        else if (gateway.boundChatId !== undefined) {
          notify("已绑定会话。要换绑请先 /feishu unbind");
        } else if (gateway instanceof BrokerGateway) {
          await requestBrokerPairingCode(gateway, notify);
        } else {
          pairing ??= createPairing(config?.pairingTtlMs ?? 600_000, randomInt);
          issuePairingCode(notify);
        }
      }
      else if (sub === "unbind") {
        if (!gateway) notify("飞书桥接未在运行");
        else if (gateway instanceof BrokerGateway) {
          // 绑定权在 broker 手里：本地 unbind() 只是让这边不再认那个 chatId，
          // 真正的解绑要靠已经在 unbind() 里发出的 unbind 帧
          gateway.unbind();
          await requestBrokerPairingCode(gateway, notify, "已解绑。");
        } else {
          gateway.unbind();
          if (config?.bindTarget === "code") {
            pairing ??= createPairing(config.pairingTtlMs, randomInt);
            issuePairingCode(notify);
          } else notify("已解绑，下一条消息会重新绑定会话");
        }
      }
      else if (sub === "status") notify(await statusText()); else notify(`未知子命令：${sub}。可用：start / stop / status / pair / unbind`);
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

    // RPC 模式下 ctx.hasUI 也是 true（dialog 方法走 extension UI 子协议），
    // 但 ctx.ui.confirm() 会阻塞等待 stdin 的 extension_ui_response，
    // 无客户端配合就会卡死。飞书卡片审批走独立 WebSocket，与 pi 模式无关，
    // 所以 RPC/headless 下只用飞书卡片审批即可。
    const tuiAsker: Asker | undefined = ctx.mode === "tui"
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
