import path from "node:path";
import { randomInt } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ConfigError, loadConfig, readConfigFile, type Config } from "./config.ts";
import { createLogger } from "./log.ts";
import { FeishuGateway } from "./feishu.ts";
import fs from "node:fs";
import { gateImagePath, sniffImageType, MAX_IMAGE_BYTES } from "./image.ts";
import {
  announceAndBind,
  bindToChat,
  Bridge,
  decideDelivery,
  gateInbound,
  parseControlCommand,
  shouldAccept,
} from "./bridge.ts";
import { describeInbound, renderStatus, renderUnbindNotice } from "./renderer.ts";
import { createPairing, type Pairing } from "./pairing.ts";
import type { Asker } from "./approval.ts";
import type { InboundMessage, SendTarget } from "./types.ts";
import { DispatchWatchdog } from "./dispatch-watchdog.ts";

/**
 * 回执发回消息本来所在的地方：消息在话题里就回进那个话题，否则直接发进会话。
 *
 * 话题群里不这么做的话，回执会掉在群主干上 —— 提问的人在话题里等，
 * 而答复出现在别处。普通群和私聊没有 threadId，退化成原来的行为。
 */
function replyTargetOf(msg: InboundMessage): SendTarget {
  return msg.threadId === undefined
    ? { chatId: msg.chatId }
    : { chatId: msg.chatId, replyTo: msg.messageId, inThread: true };
}

/** 会话切换时等待断开的上限，防止飞书 API 挂住把 /new 一起冻住 */
const SHUTDOWN_TIMEOUT_MS = 5_000;
/** void sendUserMessage 没有失败回调；两分钟还没到 before_agent_start 就止损，不能永久占住桥 */
const DISPATCH_START_TIMEOUT_MS = 120_000;

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
  let pairing: Pairing | undefined;
  const dispatchWatchdog = new DispatchWatchdog(DISPATCH_START_TIMEOUT_MS);

  /**
   * ExtensionAPI 把真实 Promise rejection 收进 runtime error，扩展拿不到；watchdog 是
   * 未选模型、鉴权失败等 preflight 在 agent_start 前失败时唯一可用的止损。
   */
  function armDispatchTimer(
    br: Bridge,
    gw: FeishuGateway,
    messageId: string,
    target: SendTarget | string,
  ): void {
    dispatchWatchdog.arm(messageId, () => {
      if (bridge !== br || gateway !== gw || !br.expireDispatch(messageId)) return;
      // 尽量中止仍挂在 preflight/compaction 的迟到任务；即使 abort 自己失败，
      // reservation 也已经释放，不能让整座桥永久只进队列不出队。
      try {
        ctxRef?.abort();
      } catch (err) {
        log(`投递超时后中止 pi 失败：${String(err)}`, "warning");
      }
      log(`消息在 ${DISPATCH_START_TIMEOUT_MS}ms 内未进入 agent_start，已释放投递占位`, "error");
      // 先调用 release：async 函数会在首个 await 前同步拿走并 reserve 下一条。
      // 失败回执是外部网络 IO，不能让它挂住旧队列，也不能给新入站留下抢跑窗口。
      void releaseOneDeferred(br, gw).catch((err: unknown) =>
        log(`投递超时后继续放行队列失败：${String(err)}`, "error"),
      );
      void gw.sendText("这条消息未能启动处理，请再发一次。", target).catch(() => {});
    });
  }

  /** settled 或 watchdog 之后只放一条；它的 settled 会继续驱动下一条。 */
  async function releaseOneDeferred(
    br: Bridge,
    gw: FeishuGateway,
  ): Promise<void> {
    if (br.isAgentActive) return;
    const next = br.takeDeferred();
    if (!next) return;
    const target = br.origins.targetOf(next.messageId) ?? next.chatId;
    const dispatched = br.dispatchToAgent(next.messageId, next.text, undefined, () => {
      pi.sendUserMessage(next.text);
    });
    if (dispatched.kind === "busy") {
      // 从 isAgentActive 到 dispatchToAgent 没有 await，正常不可达；保守回队尾。
      br.defer(next.messageId, next.chatId, next.text);
      return;
    }
    if (dispatched.kind === "sent") {
      armDispatchTimer(br, gw, next.messageId, target);
      return;
    }
    log(`扣住的消息重新发起失败：${String(dispatched.error)}`, "error");
    // 同步失败没有 agent_settled 帮忙驱动；失败回执也不能阻塞后续队列。
    void gw.sendText("刚才那条消息没能处理，请再发一次。", target).catch(() => {});
    await releaseOneDeferred(br, gw);
  }

  /** 签发配对码并只在终端显示 —— 发进飞书就等于把门钥匙挂门上了 */
  function issuePairingCode(notify: (msg: string) => void): void {
    if (!pairing) return;
    const code = pairing.issue();
    const minutes = Math.round((config?.pairingTtlMs ?? 600_000) / 60_000);
    notify(
      `飞书桥接已启动，等待配对。\n在要绑定的飞书对话里发送这串配对码（${minutes} 分钟内有效）：\n\n    ${code}\n`,
    );
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

    const gw = new FeishuGateway(cfg, log);
    const br = new Bridge(cfg, gw, log);

    gw.onMessage((msg) => {
      void (async () => {
        try {
          // 先登记来源，在任何放行判定之前 —— 被挡掉的消息也要有来源，
          // 否则回绝的话都发不回去
          br.recordInbound(msg);
          // 待配对时，未绑定状态下只认配对码 —— 任何其他消息都不该绑上来，
          // 否则「先握手再绑定」就形同虚设。
          // 注意 match() 是一次性的，只有真要判定时才调，别在条件里顺手调用
          const gate = gateInbound({
            bound: gw.boundChatId !== undefined,
            multiChat: cfg.multiChat,
            requireCode: cfg.bindTarget === "code",
            codePending: pairing?.pending === true,
            codeMatched: pairing?.pending === true && pairing.match(msg.text),
          });
          if (gate === "pair-ok") {
            gw.bind(msg.chatId);
            log(`配对成功，已绑定 ${msg.chatId}`);
            await gw.sendText("配对成功，本对话已绑定该 pi 会话。", replyTargetOf(msg));
            return;
          }
          if (gate === "need-code") {
            // 不回显配对码。过期与不匹配给同一句话，但要说清楚去哪拿新的
            await gw.sendText(
              "该 pi 会话尚未配对。请发送终端上显示的配对码；" +
                "码已过期的话，在终端跑 /feishu pair 取一个新的。",
              replyTargetOf(msg),
            );
            return;
          }

          if (!shouldAccept(gw, msg.chatId, cfg.multiChat)) {
            // 必须显式指定收件会话，否则会发到已绑定的那个会话去
            await gw.sendText("该 pi 会话已绑定到其他对话。", replyTargetOf(msg));
            return;
          }
          log(describeInbound(msg));
          if (gw.boundChatId === undefined) gw.bind(msg.chatId);

          const control = parseControlCommand(msg.text);
          if (control) {
            if (control.kind === "stop") await stop((m) => void gw.sendText(m));
            else if (control.kind === "unbind") {
              // 先回执再解绑：解绑后 sendText 没有默认收件方，必须显式指定本会话。
              await gw.sendText(
                renderUnbindNotice(),
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
          // 用 isAgentActive 而不是 isStreaming：agent_end 之后 pi 还可能在
          // 自动重试/压缩上下文，那段窗口里不带 deliverAs 直接发会被
          // prompt() 抛 "Agent is already processing"，消息就丢了
          const { text, deliverAs } = decideDelivery(content, br.isAgentActive);
          if (text === "") return;
          // 开始处理就给这条消息加个「在看」的表情 —— 飞书没有给机器人
          // 「标记已读」的接口，表情是通行做法。fire-and-forget：加不上不该
          // 影响消息处理，react 内部已自兜异常
          void gw.react?.(msg.messageId, cfg.readReceiptEmoji);

          // 回合进行中的普通新消息一律扣住，等这轮跑完再单独成回合：跨对话时
          // 防止答案发错地方；同一对话时保证一问一卡，别只更新上方的旧卡片。
          // 当前对话用 ! 显式 steer 是唯一例外。理由详见 deferred.ts
          if (br.shouldDefer(msg.messageId, deliverAs)) {
            if (br.defer(msg.messageId, msg.chatId, text)) {
              await gw.sendText("当前请求还在处理中，这条已排队，完成后会另开卡片回复。", replyTargetOf(msg));
            } else {
              await gw.sendText("排队的消息太多了，这条没接住，请稍后再发一次。", replyTargetOf(msg));
            }
            return;
          }

          // sendUserMessage 是 fire-and-forget 的 void API；Bridge 把占位、来源登记、
          // 调用和同步失败回滚收在同一个无 await 的同步段里。
          const dispatched = br.dispatchToAgent(msg.messageId, text, deliverAs, () => {
            pi.sendUserMessage(text, deliverAs ? { deliverAs } : undefined);
          });
          if (dispatched.kind === "busy") {
            if (br.defer(msg.messageId, msg.chatId, text)) {
              await gw.sendText("当前请求还在处理中，这条已排队，完成后会另开卡片回复。", replyTargetOf(msg));
            } else {
              await gw.sendText("排队的消息太多了，这条没接住，请稍后再发一次。", replyTargetOf(msg));
            }
            return;
          }
          if (dispatched.kind === "failed") {
            log(`消息未能交给 pi：${String(dispatched.error)}`, "error");
            await gw.sendText("这条消息没能交给 pi 处理，请再发一次。", replyTargetOf(msg)).catch(() => {});
          } else if (dispatched.kind === "sent" && deliverAs !== "steer") {
            armDispatchTimer(br, gw, msg.messageId, replyTargetOf(msg));
          }
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
      // 报 isAgentActive 而不是 isStreaming：飞书流收尾后 pi 可能还在自动重试，
      // 那会儿说「空闲」但下一条消息却被扣住，对不上
      streaming: bridge?.isAgentActive,
      turnApproved: bridge?.turnApproved,
    });
  }

  async function stop(notify: (msg: string) => void): Promise<void> {
    const gw = gateway;
    const br = bridge;
    gateway = undefined;
    bridge = undefined;
    dispatchWatchdog.clearAll();
    if (!gw) {
      notify("飞书桥接未在运行");
      return;
    }
    // 先回执再断开：飞书侧的 notify 走的正是 gw.sendText，
    // disconnect 会把 channel 清掉，之后再发就是静默丢弃
    pairing?.cancel();
    pairing = undefined;
    notify("飞书桥接已停止");
    // 扣住的消息一条都不会再处理了，必须挨个告知 ——
    // 静默丢掉的话，那几个人会一直等一个永远不来的回复
    for (const stranded of br?.takeAllDeferred() ?? []) {
      await gw.sendText("飞书桥接已停止，你刚才那条消息不会被处理了。", stranded.chatId)
        .catch((err: unknown) => log(`告知未处理消息失败：${String(err)}`, "warning"));
    }
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
        } else {
          pairing ??= createPairing(config?.pairingTtlMs ?? 600_000, randomInt);
          issuePairingCode(notify);
        }
      }
      else if (sub === "unbind") {
        if (!gateway) notify("飞书桥接未在运行");
        else {
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
    const source = event.source === "extension" ? "feishu" : "interactive";
    bridge?.onUserPrompt(event.text, source);
  });

  // 认领触发这轮的那条消息。必须在 agent_start 之前，而 pi 正是这个顺序：
  // before_agent_start 在 prompt() 里发（agent-session.js 的 emitBeforeAgentStart），
  // agent_start 由随后启动的 agent 循环发出。
  //
  // 这是 pi 唯一提供的「回合 ↔ 消息」关联：event.prompt 就是 sendUserMessage
  // 收到的原字符串（走 expandPromptTemplates: false，pi 不改写）。
  // 终端敲的字也会走到这儿，认领不到任何消息，于是来源置空、出站退回已绑定会话 ——
  // 这正好替掉了原先手动清 #lastOrigin 的那一步。
  pi.on("before_agent_start", (event) => {
    dispatchWatchdog.clear(bridge?.claimTurnOrigin(event.prompt));
  });

  pi.on("agent_start", () => {
    dispatchWatchdog.clear(bridge?.startTurn());
  });

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

  // 放行扣住的消息。必须是 agent_settled 而不是 agent_end ——
  // agent_settled 的发出点在 `_isAgentRunActive = false` 之后
  // （agent-session.js 的 _emitAgentSettled），此时 sendUserMessage 才会走
  // 非排队路径、开出一个新的 agent_start；在 agent_end 里发会被当成排队消息
  // 并回同一个运行，等于没修。
  //
  // 一次只放一条：它自己会开一个新回合，下一条等那个回合 settled 再放，
  // 已经进入 DeferredQueue 的消息按 FIFO 放行。
  pi.on("agent_settled", async () => {
    const br = bridge;
    const gw = gateway;
    if (!br) return;
    // 先记下 pi 已经闲下来了，再决定放不放行 —— 漏了这句，之后所有消息
    // 都会被当成「回合进行中」永远扣着
    br.settleAgent();
    if (!gw) return;
    await releaseOneDeferred(br, gw);
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

    // 把这次工具调用绑到触发它的那条消息，审批卡片才能弹回原始对话
    bridge.origins.bindToolCall(event.toolCallId, bridge.originMessageId);
    return await bridge.gateToolCall(event.toolName, event.input, tuiAsker, event.toolCallId);
  });

  // ── feishu_send_image ──────────────────────────────────────────────
  //
  // 参数用手写的 JSON Schema 而不是 typebox：typebox 只存在于 pi 自己的
  // node_modules 里，从本仓库 import 运行期直接 ERR_MODULE_NOT_FOUND（实测过）。
  // pi 把 parameters 原样透给模型、不做 TypeBox 校验，普通 JSON Schema 就够。
  //
  // 审批不在这里做：工具名已进 risk.ts 的 EXFIL_TOOLS，上面那个 tool_call
  // 处理器会照常拦它。这里只管「哪些文件允许被送出去」。
  const sendImageParams = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "本地图片路径。必须落在仓库根目录内，或 feishu.json 的 imageDirs 白名单目录下；" +
          "软链按真实目标判定。支持 png / jpeg / gif / bmp / webp，上限 10MB。",
      },
    },
    required: ["path"],
  };

  pi.registerTool({
    name: "feishu_send_image",
    label: "发图到飞书",
    description:
      "把一张本地图片作为飞书图片消息发出去 —— 对方直接看到图，不是链接（内网链接对方打不开）。" +
      "典型用途：把浏览器截图发给对方看。发往触发本回合的那个对话，未绑定时发往已绑定会话。",
    promptSnippet: "feishu_send_image(path) — 把本地图片发进飞书对话",
    parameters: sendImageParams as never,

    async execute(toolCallId, params) {
      const raw = (params as { path?: unknown }).path;
      if (typeof raw !== "string" || raw.trim() === "") throw new Error("path 必须是非空字符串");

      const cfg = config;
      const gw = gateway;
      if (!cfg || !gw) throw new Error("飞书桥接没在运行，先在终端执行 /feishu start");
      // 目录判定按 realpath 走，否则白名单目录里放个软链就能把任意文件带出去。
      // 文件不存在时 realpathSync 会抛，退回原串 —— 后面 readFile 会给出更准的错。
      const gate = gateImagePath({
        path: raw,
        repoRoot: cfg.repoRoot,
        imageDirs: cfg.imageDirs,
        resolvePath: (p) => {
          try {
            return fs.realpathSync(p);
          } catch {
            return p;
          }
        },
      });
      if (!gate.ok) throw new Error(`拒绝发送：${gate.reason}`);

      const buf = await fs.promises.readFile(gate.path);
      if (buf.length > MAX_IMAGE_BYTES) {
        throw new Error(`图片 ${buf.length} 字节，超过飞书 ${MAX_IMAGE_BYTES} 字节的上限`);
      }
      // 按魔数认，不看扩展名 —— 否则把任意文件改叫 .png 就绕过了目录白名单的意义
      const kind = sniffImageType(buf);
      if (kind === undefined) throw new Error(`${gate.path} 不是图片（按文件头判定），拒绝发送`);

      // 与审批卡片同一套目标解析：优先本次工具调用所属的那条消息的来源对话
      const to = bridge?.origins.targetOfToolCall(toolCallId) ?? bridge?.turnSendTarget;
      if ((to?.chatId ?? gw.boundChatId) === undefined) {
        throw new Error("还没有绑定任何飞书对话，图片无处可发");
      }
      await gw.sendImage(buf, to);

      return {
        content: [{ type: "text" as const, text: `已发送 ${kind} 图片（${buf.length} 字节）到飞书` }],
        details: undefined,
      };
    },
  });
}
