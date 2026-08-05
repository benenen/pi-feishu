import { test } from "node:test";
import assert from "node:assert/strict";
import {
  announceAndBind,
  bindToChat,
  Bridge,
  decideDelivery,
  gateInbound,
  parseControlCommand,
  shouldAccept,
} from "../extensions/feishu/bridge.ts";
import type { GatewayLike } from "../extensions/feishu/bridge.ts";

test("飞书侧控制命令被识别，不进 agent", () => {
  assert.deepEqual(parseControlCommand("/feishu status"), { kind: "status" });
  assert.deepEqual(parseControlCommand("/feishu stop"), { kind: "stop" });
  assert.deepEqual(parseControlCommand("/feishu"), { kind: "help" });
  assert.deepEqual(parseControlCommand("  /feishu   status  "), { kind: "status" });
});

test("未知子命令归为 help，而不是漏给 agent", () => {
  assert.deepEqual(parseControlCommand("/feishu wat"), { kind: "help" });
});

test("普通消息不被误判为控制命令", () => {
  assert.equal(parseControlCommand("帮我看下 /feishu 怎么配"), undefined);
  assert.equal(parseControlCommand("跑测试"), undefined);
});

test("飞书侧不提供 start —— 连接只能从终端发起", () => {
  // start 会读配置并建长连接，必须由终端持有者显式发起
  assert.deepEqual(parseControlCommand("/feishu start"), { kind: "help" });
});

test("空闲时不指定投递方式", () => {
  assert.deepEqual(decideDelivery("跑测试", false), { text: "跑测试" });
});

test("流式进行中默认排队", () => {
  assert.deepEqual(decideDelivery("再看下日志", true), {
    text: "再看下日志",
    deliverAs: "followUp",
  });
});

test("! 前缀在流式中触发打断并剥掉前缀", () => {
  assert.deepEqual(decideDelivery("!停下改用 pnpm", true), {
    text: "停下改用 pnpm",
    deliverAs: "steer",
  });
});

test("! 前缀在空闲时只剥前缀，不设投递方式", () => {
  assert.deepEqual(decideDelivery("!直接跑", false), { text: "直接跑" });
});

test("! 后的空白被清理", () => {
  assert.deepEqual(decideDelivery("!   停", true), { text: "停", deliverAs: "steer" });
});

test("未绑定时接受任意会话", () => {
  assert.equal(shouldAccept({}, "oc_a"), true);
});

test("已绑定时只接受同一会话", () => {
  assert.equal(shouldAccept({ boundChatId: "oc_a" }, "oc_a"), true);
  assert.equal(shouldAccept({ boundChatId: "oc_a" }, "oc_b"), false);
});

/** 最小可用的假网关，够 Bridge 跑完一个回合 */
function fakeGateway(overrides: Partial<GatewayLike> = {}): GatewayLike {
  return {
    bind() {},
    onMessage() {},
    async streamTurn(run) {
      await run({ async append() {} });
    },
    async sendText() {},
    async downloadImage() {
      return undefined;
    },
    askerFor: () => async () => ({ allow: false, reason: "未接线" }),
    ...overrides,
  };
}

const CONFIG = {
  appId: "a",
  appSecret: "b",
  autoStart: false,
  dmMode: "allowlist" as const,
  dmAllowlist: ["ou_1"],
  groupAllowlist: [],
  approverAllowlist: ["ou_1"],
  operatorOpenId: "ou_1",
  bindTarget: "operator",
  pairingTtlMs: 600_000,
  requireMention: true,
  multiChat: false,
  readReceiptEmoji: "GLANCE",
  approvalMode: "balanced" as const,
  denyPatterns: [],
  allowPatterns: [],
  approvalTimeoutMs: 1000,
  repoRoot: "/work/repo",
  imageDirs: [],
  transport: "direct" as const,
  brokerSocket: "/work/repo/feishu-broker.sock",
  autoStartBroker: true,
};

test("流式收尾卡住时 endTurn 不会永久挂起，改为补发全文", async () => {
  const sent: string[] = [];
  const gateway = fakeGateway({
    // 挂住不返回 —— 既不 resolve 也不 reject
    streamTurn: () => new Promise<void>(() => {}),
    async sendText(markdown) {
      sent.push(markdown);
    },
  });
  const bridge = new Bridge(CONFIG, gateway, () => {}, () => 0, 20);

  bridge.startTurn();
  bridge.onTextDelta("半截内容");
  await bridge.endTurn();

  assert.equal(sent.length, 1, "应补发一次全文");
  assert.ok(sent[0].includes("半截内容"));
});

test("流式正常时不补发", async () => {
  const sent: string[] = [];
  const bridge = new Bridge(
    CONFIG,
    fakeGateway({
      async sendText(markdown) {
        sent.push(markdown);
      },
    }),
    () => {},
    () => 0,
    1000,
  );
  bridge.startTurn();
  bridge.onTextDelta("内容");
  await bridge.endTurn();
  assert.deepEqual(sent, [], "流式成功就不该再发一遍");
});

test("isStreaming 跟随回合起止", async () => {
  const bridge = new Bridge(CONFIG, fakeGateway(), () => {}, () => 0, 1000);
  assert.equal(bridge.isStreaming, false);
  bridge.startTurn();
  assert.equal(bridge.isStreaming, true);
  await bridge.endTurn();
  assert.equal(bridge.isStreaming, false);
});

test("没有开过回合时 endTurn 是安全的空操作", async () => {
  const bridge = new Bridge(CONFIG, fakeGateway(), () => {}, () => 0, 1000);
  await bridge.endTurn();
  await bridge.endTurn();
});

test("gateToolCall：安全命令直接放行，危险命令被拒后返回 block", async () => {
  const bridge = new Bridge(CONFIG, fakeGateway(), () => {}, () => 0, 1000);
  assert.equal(await bridge.gateToolCall("bash", { command: "ls -la" }, undefined), undefined);

  const blocked = await bridge.gateToolCall("bash", { command: "rm -rf /" }, undefined);
  assert.deepEqual(blocked, { block: true, reason: "未接线" });
});

test("gateToolCall：审批通道全挂时 fail-closed", async () => {
  const bridge = new Bridge(
    CONFIG,
    fakeGateway({
      askerFor: () => async () => {
        throw new Error("飞书未连接");
      },
    }),
    () => {},
    () => 0,
    1000,
  );
  const blocked = await bridge.gateToolCall("bash", { command: "rm -rf /" }, undefined);
  assert.equal(blocked?.block, true);
  assert.ok(blocked?.reason.includes("审批通道不可用"));
});

// ── 本回合全部允许 ──────────────────────────────────────────────────

/** 卡片返回带 scope:"turn" 的批准 */
const turnApprover = (calls: { n: number }) =>
  fakeGateway({
    askerFor: () => async () => {
      calls.n += 1;
      return { allow: true, reason: "飞书批准", scope: "turn" as const };
    },
  });

test("批准一次「本回合全部允许」后，同回合内后续危险调用不再询问", async () => {
  const calls = { n: 0 };
  const bridge = new Bridge(CONFIG, turnApprover(calls), () => {}, () => 0, 1000);
  bridge.startTurn();

  assert.equal(await bridge.gateToolCall("bash", { command: "rm -rf a" }, undefined), undefined);
  assert.equal(await bridge.gateToolCall("bash", { command: "chmod 777 ." }, undefined), undefined);
  assert.equal(await bridge.gateToolCall("write", { path: "/etc/x" }, undefined), undefined);
  assert.equal(calls.n, 1, "只应该问过一次");
});

test("回合结束后豁免失效，下个回合重新询问", async () => {
  const calls = { n: 0 };
  const bridge = new Bridge(CONFIG, turnApprover(calls), () => {}, () => 0, 1000);

  bridge.startTurn();
  await bridge.gateToolCall("bash", { command: "rm -rf a" }, undefined);
  await bridge.endTurn();

  bridge.startTurn();
  await bridge.gateToolCall("bash", { command: "rm -rf b" }, undefined);
  assert.equal(calls.n, 2, "新回合必须重新问");
});

test("不带 scope 的普通批准只对当次生效", async () => {
  let n = 0;
  const bridge = new Bridge(
    CONFIG,
    fakeGateway({
      askerFor: () => async () => {
        n += 1;
        return { allow: true, reason: "飞书批准" };
      },
    }),
    () => {},
    () => 0,
    1000,
  );
  bridge.startTurn();
  await bridge.gateToolCall("bash", { command: "rm -rf a" }, undefined);
  await bridge.gateToolCall("bash", { command: "rm -rf b" }, undefined);
  assert.equal(n, 2, "普通批准不能顺带豁免后续");
});

test("拒绝带 scope 也不会开启豁免 —— 只有批准才算", async () => {
  let n = 0;
  const bridge = new Bridge(
    CONFIG,
    fakeGateway({
      askerFor: () => async () => {
        n += 1;
        return { allow: false, reason: "飞书拒绝", scope: "turn" as const };
      },
    }),
    () => {},
    () => 0,
    1000,
  );
  bridge.startTurn();
  assert.equal((await bridge.gateToolCall("bash", { command: "rm -rf a" }, undefined))?.block, true);
  assert.equal((await bridge.gateToolCall("bash", { command: "rm -rf b" }, undefined))?.block, true);
  assert.equal(n, 2);
});

// ── 主动私信并绑定 ──────────────────────────────────────────────────

interface AnnounceCall {
  openId: string;
  text: string;
}

function fakeAnnouncer(
  calls: AnnounceCall[],
  result: string | undefined | Error,
  bound?: string,
) {
  return {
    boundChatId: bound,
    bind(chatId: string) {
      this.boundChatId = chatId;
    },
    async announce(openId: string, text: string) {
      calls.push({ openId, text });
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

test("announceAndBind：私信成功后用回来的 chat_id 完成绑定", async () => {
  const calls: AnnounceCall[] = [];
  const gw = fakeAnnouncer(calls, "oc_p2p_1");
  const ok = await announceAndBind(gw, "ou_me", "已就绪", () => {});
  assert.equal(ok, true);
  assert.equal(gw.boundChatId, "oc_p2p_1");
  assert.deepEqual(calls, [{ openId: "ou_me", text: "已就绪" }]);
});

test("announceAndBind：私信失败不抛异常，也不绑定 —— start 不能被它带崩", async () => {
  const logged: string[] = [];
  const gw = fakeAnnouncer([], new Error("bot 对该用户不可用"));
  const ok = await announceAndBind(gw, "ou_me", "已就绪", (m) => logged.push(m));
  assert.equal(ok, false);
  assert.equal(gw.boundChatId, undefined);
  assert.ok(logged.some((m) => m.includes("不可用")), "失败原因要留在日志里");
});

test("announceAndBind：拿不到 chat_id 时不绑定", async () => {
  const gw = fakeAnnouncer([], undefined);
  assert.equal(await announceAndBind(gw, "ou_me", "已就绪", () => {}), false);
  assert.equal(gw.boundChatId, undefined);
});

test("announceAndBind：已绑定时不再打扰操作员", async () => {
  const calls: AnnounceCall[] = [];
  const gw = fakeAnnouncer(calls, "oc_new", "oc_already");
  const ok = await announceAndBind(gw, "ou_me", "已就绪", () => {});
  assert.equal(ok, false);
  assert.equal(gw.boundChatId, "oc_already", "原有绑定不能被顶掉");
  assert.deepEqual(calls, [], "不该发消息");
});

// ── bindTarget 为群 chat_id：直接绑，不需要先私信 ───────────────────

function fakeChatBinder(sent: { chatId: string; text: string }[], fail?: Error) {
  return {
    boundChatId: undefined as string | undefined,
    bind(chatId: string) {
      this.boundChatId = chatId;
    },
    async sendText(text: string, to?: string) {
      if (fail) throw fail;
      sent.push({ chatId: to ?? "(bound)", text });
    },
  };
}

test("bindToChat：直接绑定指定会话并往里发一条就绪通知", async () => {
  const sent: { chatId: string; text: string }[] = [];
  const gw = fakeChatBinder(sent);
  assert.equal(await bindToChat(gw, "oc_group", "已就绪", () => {}), true);
  assert.equal(gw.boundChatId, "oc_group");
  assert.deepEqual(sent, [{ chatId: "oc_group", text: "已就绪" }]);
});

test("bindToChat：通知发不出去仍然完成绑定 —— 入站过滤不能因为出站坏了就失效", async () => {
  const logged: string[] = [];
  const gw = fakeChatBinder([], new Error("机器人不在该群"));
  assert.equal(await bindToChat(gw, "oc_group", "已就绪", (m) => logged.push(m)), true);
  assert.equal(gw.boundChatId, "oc_group");
  assert.ok(logged.some((m) => m.includes("不在该群")));
});

test("bindToChat：已绑定时不动它", async () => {
  const sent: { chatId: string; text: string }[] = [];
  const gw = fakeChatBinder(sent);
  gw.boundChatId = "oc_already";
  assert.equal(await bindToChat(gw, "oc_group", "已就绪", () => {}), false);
  assert.equal(gw.boundChatId, "oc_already");
  assert.deepEqual(sent, []);
});

test("飞书侧也能发 /feishu unbind 解绑", () => {
  assert.deepEqual(parseControlCommand("/feishu unbind"), { kind: "unbind" });
  assert.deepEqual(parseControlCommand("  /feishu   UNBIND "), { kind: "unbind" });
});

// ── 多会话：一个 pi 会话同时接私聊与群 @，回复回到来源 ──────────────

/** 记录每次出站调用的目标，用来断言「回给了谁」 */
function targetTrackingGateway(sink: {
  streams: (string | undefined)[];
  texts: { text: string; to?: string }[];
  asks: (string | undefined)[];
}): GatewayLike {
  return {
    bind() {},
    onMessage() {},
    async streamTurn(run, to) {
      sink.streams.push(typeof to === "string" || to === undefined ? to : to.chatId);
      await run({ async append() {} });
    },
    async sendText(text, to) {
      sink.texts.push({ text, to: typeof to === "string" || to === undefined ? to : to.chatId });
    },
    async downloadImage() {
      return undefined;
    },
    askerFor(to) {
      return async () => {
        sink.asks.push(typeof to === "string" || to === undefined ? to : to.chatId);
        return { allow: false, reason: "未接线" };
      };
    },
  };
}

const MULTI = { ...CONFIG, multiChat: true };

function emptySink() {
  return { streams: [] as (string | undefined)[], texts: [], asks: [] };
}

/**
 * 走一遍真实的入站→认领链路：登记消息 → 登记发给 pi 的原文 →
 * before_agent_start 按原文认领。测试里不该直接塞一个 chatId 进去，
 * 那样就绕过了正要验的那段。
 */
let seq = 0;
function claimFrom(bridge: Bridge, chatId: string, messageId?: string, text?: string, question?: string) {
  const id = messageId ?? `om_${(seq += 1)}`;
  const prompt = text ?? `来自 ${chatId} 的第 ${seq} 条`;
  bridge.recordInbound({ messageId: id, chatId, senderId: "ou_1", text: question ?? prompt });
  bridge.noteInboundPrompt(id, prompt);
  bridge.claimTurnOrigin(prompt);
}

function inboundFrom(bridge: Bridge, chatId: string, threadId?: string): string {
  const messageId = `om_inbound_${(seq += 1)}`;
  bridge.recordInbound({ messageId, chatId, senderId: "ou_1", text: messageId, threadId });
  return messageId;
}

test("流式失败时补发的全文也发回同一个来源", async () => {
  const texts: { text: string; to?: string }[] = [];
  const gw = targetTrackingGateway({ streams: [], texts, asks: [] });
  const failing: GatewayLike = {
    ...gw,
    async streamTurn() {
      throw new Error("飞书限流");
    },
  };
  const bridge = new Bridge(MULTI, failing, () => {}, () => 0, 1000);

  claimFrom(bridge, "oc_group");
  bridge.startTurn();
  bridge.onTextDelta("结果");
  await bridge.endTurn();

  assert.equal(texts.at(-1)?.to, "oc_group", "补发全文发错对话，等于把内容漏给别人");
});

test("审批卡片发到触发该回合的那个对话", async () => {
  const asks: (string | undefined)[] = [];
  const bridge = new Bridge(
    MULTI,
    targetTrackingGateway({ streams: [], texts: [], asks }),
    () => {},
    () => 0,
    1000,
  );

  claimFrom(bridge, "oc_group");
  bridge.startTurn();
  await bridge.gateToolCall("bash", { command: "rm -rf x" }, undefined);

  assert.deepEqual(asks, ["oc_group"], "审批卡片弹错对话，就是让不相干的人看见并批准");
});

test("multiChat 关闭时行为不变：仍只认已绑定的那个会话", () => {
  assert.equal(shouldAccept({ boundChatId: "oc_a" }, "oc_b", false), false);
  assert.equal(shouldAccept({ boundChatId: "oc_a" }, "oc_a", false), true);
  assert.equal(shouldAccept({}, "oc_any", false), true, "未绑定时仍接受首条");
});

test("multiChat 打开时接受任何会话 —— 过滤交给飞书侧的策略管道", () => {
  assert.equal(shouldAccept({ boundChatId: "oc_a" }, "oc_b", true), true);
  assert.equal(shouldAccept({}, "oc_whatever", true), true);
});

test("已绑定的会话直接放行", () => {
  assert.equal(
    gateInbound({ bound: true, multiChat: false, requireCode: true, codePending: true, codeMatched: false }),
    "pass",
  );
});

test("multiChat 不要求配对 —— 它的语义就是全接，再要握手是自相矛盾", () => {
  assert.equal(
    gateInbound({ bound: false, multiChat: true, requireCode: true, codePending: true, codeMatched: false }),
    "pass",
  );
});

test("要求配对码时：码有效且匹配才算配对成功", () => {
  assert.equal(
    gateInbound({ bound: false, multiChat: false, requireCode: true, codePending: true, codeMatched: true }),
    "pair-ok",
  );
  assert.equal(
    gateInbound({ bound: false, multiChat: false, requireCode: true, codePending: true, codeMatched: false }),
    "need-code",
  );
});

test("配对码过期后必须继续挡着，不能变成谁先说话谁绑上", () => {
  // 这是 fail-open：过期让 pending 变 false，整个配对分支被跳过，
  // 下一条消息不需要任何码就绑上了 —— 门不是关得更严，而是没了
  assert.equal(
    gateInbound({ bound: false, multiChat: false, requireCode: true, codePending: false, codeMatched: false }),
    "need-code",
  );
});

test("不走配对码的档位（operator / oc_xxx / none）仍是首条消息即绑", () => {
  assert.equal(
    gateInbound({ bound: false, multiChat: false, requireCode: false, codePending: false, codeMatched: false }),
    "pass",
  );
});

test("终端输入清掉来源 —— 不能沿用上一条飞书消息的对话", async () => {
  const sink = { streams: [] as (string | undefined)[], texts: [], asks: [] };
  const bridge = new Bridge(MULTI, targetTrackingGateway(sink), () => {}, () => 0, 1000);

  claimFrom(bridge, "oc_group");
  bridge.startTurn();
  await bridge.endTurn();

  bridge.claimTurnOrigin("我在终端敲的"); // 终端敲了一句：认领不到任何消息
  bridge.startTurn();
  await bridge.endTurn();

  assert.deepEqual(sink.streams, ["oc_group", undefined]);
});

test("两条来自不同对话的消息，各自的回合回各自的对话", async () => {
  const sink = { streams: [] as (string | undefined)[], texts: [], asks: [] };
  const bridge = new Bridge(MULTI, targetTrackingGateway(sink), () => {}, () => 0, 1000);

  claimFrom(bridge, "oc_dm");
  bridge.startTurn();
  await bridge.endTurn();

  claimFrom(bridge, "oc_group");
  bridge.startTurn();
  await bridge.endTurn();

  assert.deepEqual(sink.streams, ["oc_dm", "oc_group"]);
});

test("飞书回合的新卡片以对应问题开头，再显示回答", async () => {
  const chunks: string[] = [];
  const bridge = new Bridge(
    MULTI,
    fakeGateway({
      async streamTurn(run) {
        await run({
          async append(chunk) {
            chunks.push(chunk);
          },
        });
      },
    }),
    () => {},
    () => 0,
    1000,
  );

  claimFrom(
    bridge,
    "oc_dm",
    "om_question",
    "看下 总共有多少个员工\n[图片 img_x，123 字节]",
    "看下\n总共有多少个员工",
  );
  bridge.startTurn();
  bridge.onTextDelta("一共 13 个。");
  await bridge.endTurn();

  const card = chunks.join("");
  assert.ok(card.startsWith("> 💬 问题：看下 总共有多少个员工\n\n"), "卡片没有标出对应问题");
  assert.ok(card.includes("一共 13 个。"), "回答正文丢了");
});

test("纯图片消息没有文字原文时，卡片标题回退到实际 agent prompt", async () => {
  const chunks: string[] = [];
  const bridge = new Bridge(
    MULTI,
    fakeGateway({
      async streamTurn(run) {
        await run({ async append(chunk) { chunks.push(chunk); } });
      },
    }),
    () => {},
    () => 0,
    1000,
  );

  claimFrom(bridge, "oc_dm", "om_image", "[图片 img_x，123 字节]", "");
  bridge.startTurn();
  await bridge.endTurn();

  assert.ok(chunks.join("").startsWith("> 💬 问题：[图片 img_x，123 字节]\n\n"));
});

// ── 回合进行中来自其他对话的消息 ──────────────────────────────────

test("回合进行中，任何对话的普通新消息都要扣住", () => {
  const bridge = new Bridge(MULTI, targetTrackingGateway(emptySink()), () => {}, () => 0, 1000);
  claimFrom(bridge, "oc_dm");
  bridge.startTurn();

  assert.equal(bridge.shouldDefer(inboundFrom(bridge, "oc_group")), true, "不扣的话答案会整段发进私聊");
  assert.equal(bridge.shouldDefer(inboundFrom(bridge, "oc_dm")), true, "同聊 followUp 只会更新旧卡片，聊天底部看不到新回复");
});

test("消息已交给 pi、agent_start 尚未到达时也算忙，紧邻第二问必须扣住", () => {
  const bridge = new Bridge(MULTI, targetTrackingGateway(emptySink()), () => {}, () => 0, 1000);
  bridge.recordInbound({ messageId: "om_first", chatId: "oc_dm", senderId: "ou_1", text: "第一问" });

  assert.equal(bridge.reserveDispatch("om_first"), true);
  assert.equal(bridge.isAgentActive, true, "sendUserMessage 是 void，不能等 agent_start 才占位");

  bridge.recordInbound({ messageId: "om_second", chatId: "oc_dm", senderId: "ou_1", text: "第二问" });
  assert.equal(bridge.shouldDefer("om_second"), true, "第二问会并进第一轮、只更新第一张卡片");

  bridge.recordInbound({ messageId: "om_steer_too_early", chatId: "oc_dm", senderId: "ou_1", text: "!补充" });
  assert.equal(
    bridge.shouldDefer("om_steer_too_early", "steer"),
    true,
    "真实 agent_start 前 pi 还不在 streaming，steer 会误开并发 run，必须先扣住",
  );
});

test("void 投递接线会在调用 pi 前占位，且不会把 void 当成可等待的完成信号", () => {
  const bridge = new Bridge(MULTI, targetTrackingGateway(emptySink()), () => {}, () => 0, 1000);
  bridge.recordInbound({ messageId: "om_first", chatId: "oc_dm", senderId: "ou_1", text: "第一问" });
  const seen: string[] = [];

  const result = bridge.dispatchToAgent("om_first", "第一问", undefined, () => {
    assert.equal(bridge.isAgentActive, true, "调用 sendUserMessage 之前必须已经占位");
    seen.push("第一问");
  });

  assert.deepEqual(result, { kind: "sent" });
  assert.deepEqual(seen, ["第一问"]);
  assert.equal(bridge.isAgentActive, true, "void 返回后仍要等 agent_start/settled 生命周期");
});

test("void 投递同步失败会释放占位，且不会留下陈旧来源", () => {
  const bridge = new Bridge(MULTI, targetTrackingGateway(emptySink()), () => {}, () => 0, 1000);
  bridge.recordInbound({ messageId: "om_failed", chatId: "oc_dm", senderId: "ou_1", text: "失败的提问" });

  const result = bridge.dispatchToAgent("om_failed", "失败的提问", undefined, () => {
    throw new Error("stale extension context");
  });

  assert.equal(result.kind, "failed");
  assert.equal(bridge.isAgentActive, false);
  assert.equal(bridge.origins.chatOf("om_failed"), undefined);
});

test("取消尚未启动的投递会释放占位和来源", () => {
  const bridge = new Bridge(MULTI, targetTrackingGateway(emptySink()), () => {}, () => 0, 1000);
  bridge.recordInbound({ messageId: "om_failed", chatId: "oc_dm", senderId: "ou_1", text: "失败的提问" });
  bridge.noteInboundPrompt("om_failed", "失败的提问");
  bridge.reserveDispatch("om_failed");

  bridge.cancelDispatch("om_failed");

  assert.equal(bridge.isAgentActive, false);
  assert.equal(bridge.origins.chatOf("om_failed"), undefined, "失败投递不能留下陈旧认领索引");
});

test("同一群只有同一话题里的 ! 才能 steer 当前回合", () => {
  const bridge = new Bridge(MULTI, targetTrackingGateway(emptySink()), () => {}, () => 0, 1000);
  bridge.recordInbound({
    messageId: "om_first",
    chatId: "oc_group",
    senderId: "ou_1",
    text: "话题 A 的问题",
    threadId: "omt_A",
  });
  bridge.noteInboundPrompt("om_first", "话题 A 的问题");
  bridge.claimTurnOrigin("话题 A 的问题");
  bridge.startTurn();

  bridge.recordInbound({
    messageId: "om_same_thread",
    chatId: "oc_group",
    senderId: "ou_1",
    text: "!补充",
    threadId: "omt_A",
  });
  bridge.recordInbound({
    messageId: "om_other_thread",
    chatId: "oc_group",
    senderId: "ou_2",
    text: "!打断",
    threadId: "omt_B",
  });

  assert.equal(bridge.shouldDefer("om_same_thread", "steer"), false);
  assert.equal(bridge.shouldDefer("om_other_thread", "steer"), true, "别的话题不能劫持 A 的卡片");
});

test("默认单会话档也按 thread 区分 !，不能把话题来源压扁成 chatId", () => {
  const gw = { ...targetTrackingGateway(emptySink()), boundChatId: "oc_group" };
  const bridge = new Bridge(CONFIG, gw, () => {}, () => 0, 1000);
  bridge.recordInbound({
    messageId: "om_first",
    chatId: "oc_group",
    senderId: "ou_1",
    text: "话题 A 的问题",
    threadId: "omt_A",
  });
  bridge.noteInboundPrompt("om_first", "话题 A 的问题");
  bridge.claimTurnOrigin("话题 A 的问题");
  bridge.startTurn();

  const same = inboundFrom(bridge, "oc_group", "omt_A");
  const other = inboundFrom(bridge, "oc_group", "omt_B");
  const main = inboundFrom(bridge, "oc_group");
  assert.equal(bridge.shouldDefer(same, "steer"), false);
  assert.equal(bridge.shouldDefer(other, "steer"), true);
  assert.equal(bridge.shouldDefer(main, "steer"), true, "群主干不能 steer 正在话题里的卡片");
});

test("未启动投递超时后释放 reservation，后续消息不再永久排队", () => {
  const bridge = new Bridge(MULTI, targetTrackingGateway(emptySink()), () => {}, () => 0, 1000);
  bridge.recordInbound({ messageId: "om_timeout", chatId: "oc_dm", senderId: "ou_1", text: "会超时" });
  bridge.noteInboundPrompt("om_timeout", "会超时");
  bridge.reserveDispatch("om_timeout");

  assert.equal(bridge.expireDispatch("om_timeout"), true);
  assert.equal(bridge.isAgentActive, false);
  assert.equal(bridge.origins.chatOf("om_timeout"), undefined);
});

test("before_agent_start 已认领的投递不允许超时器误清", () => {
  const bridge = new Bridge(MULTI, targetTrackingGateway(emptySink()), () => {}, () => 0, 1000);
  bridge.recordInbound({ messageId: "om_started", chatId: "oc_dm", senderId: "ou_1", text: "已启动" });
  bridge.noteInboundPrompt("om_started", "已启动");
  bridge.reserveDispatch("om_started");
  bridge.claimTurnOrigin("已启动");

  assert.equal(bridge.expireDispatch("om_started"), false);
  assert.equal(bridge.isAgentActive, true);
  assert.equal(bridge.origins.chatOf("om_started"), "oc_dm");
});

test("终端发起的回合也把新飞书消息单独排队", () => {
  // 终端敲字时 #lastOrigin 是空的，但流实际发往已绑定的私聊。
  // 只看 #turnTarget 会以为「没目标」而放行，群消息照样串进私聊
  const gw = targetTrackingGateway(emptySink());
  const bridge = new Bridge(MULTI, { ...gw, boundChatId: "oc_dm" }, () => {}, () => 0, 1000);
  bridge.claimTurnOrigin("我在终端敲的");
  bridge.startTurn();

  assert.equal(bridge.shouldDefer(inboundFrom(bridge, "oc_group")), true);
  assert.equal(bridge.shouldDefer(inboundFrom(bridge, "oc_dm")), true, "同一绑定会话的新问题也要另开卡片");
});

test("空闲时不扣任何消息", () => {
  const bridge = new Bridge(MULTI, targetTrackingGateway(emptySink()), () => {}, () => 0, 1000);
  assert.equal(bridge.shouldDefer(inboundFrom(bridge, "oc_group")), false);
});

test("私聊回合跑完后，扣住的群消息各自成回合、回到群里", async () => {
  // 这是本次修复的核心回归：pi 把 followUp 并进同一个 agent 运行
  // （只有一次 agent_start），所以扣住 + 单独成回合是唯一能发对地方的做法
  const sink = emptySink();
  const bridge = new Bridge(MULTI, targetTrackingGateway(sink), () => {}, () => 0, 1000);

  claimFrom(bridge, "oc_dm");
  bridge.startTurn();
  bridge.recordInbound({ messageId: "om_group", chatId: "oc_group", senderId: "ou_1", text: "帮我看下这个" });
  assert.equal(bridge.shouldDefer("om_group"), true);
  bridge.defer("om_group", "oc_group", "帮我看下这个");
  await bridge.endTurn();

  const pending = bridge.takeDeferred();
  assert.deepEqual(pending, {
    messageId: "om_group",
    chatId: "oc_group",
    text: "帮我看下这个",
  });

  // 接线层拿到后重新发起 —— 新回合的来源就是群
  claimFrom(bridge, pending!.chatId, pending!.messageId, pending!.text);
  bridge.startTurn();
  await bridge.endTurn();

  assert.deepEqual(sink.streams, ["oc_dm", "oc_group"], "群的答案没回到群里");
});

test("同一对话连续两问会得到两张各带问题原文的卡片", async () => {
  const cards: string[] = [];
  const bridge = new Bridge(
    MULTI,
    fakeGateway({
      async streamTurn(run) {
        const at = cards.push("") - 1;
        await run({
          async append(chunk) {
            cards[at] += chunk;
          },
        });
      },
    }),
    () => {},
    () => 0,
    1000,
  );

  claimFrom(bridge, "oc_dm", "om_first", "第一个问题", "第一个问题");
  bridge.startTurn();
  bridge.onTextDelta("第一个回答");

  bridge.recordInbound({ messageId: "om_second", chatId: "oc_dm", senderId: "ou_1", text: "第二个问题" });
  assert.equal(bridge.shouldDefer("om_second", "followUp"), true);
  bridge.defer("om_second", "oc_dm", "第二个问题");
  await bridge.endTurn();
  bridge.settleAgent();

  const next = bridge.takeDeferred();
  assert.ok(next);
  bridge.noteInboundPrompt(next.messageId, next.text);
  bridge.claimTurnOrigin(next.text);
  bridge.startTurn();
  bridge.onTextDelta("第二个回答");
  await bridge.endTurn();

  assert.equal(cards.length, 2);
  assert.ok(cards[0].startsWith("> 💬 问题：第一个问题\n\n"));
  assert.ok(cards[0].includes("第一个回答"));
  assert.equal(cards[0].includes("第二个回答"), false);
  assert.ok(cards[1].startsWith("> 💬 问题：第二个问题\n\n"));
  assert.ok(cards[1].includes("第二个回答"));
});

test("扣住的消息按先来后到出队", async () => {
  const bridge = new Bridge(MULTI, targetTrackingGateway(emptySink()), () => {}, () => 0, 1000);
  claimFrom(bridge, "oc_dm");
  bridge.startTurn();
  bridge.defer("om_g1", "oc_g1", "一");
  bridge.defer("om_g2", "oc_g2", "二");
  await bridge.endTurn();

  assert.equal(bridge.takeDeferred()?.chatId, "oc_g1");
  assert.equal(bridge.takeDeferred()?.chatId, "oc_g2");
  assert.equal(bridge.takeDeferred(), undefined);
});

test("停止桥接时，扣住的消息要能全部取出来告知发送者", () => {
  const bridge = new Bridge(MULTI, targetTrackingGateway(emptySink()), () => {}, () => 0, 1000);
  claimFrom(bridge, "oc_dm");
  bridge.startTurn();
  bridge.defer("om_g1", "oc_g1", "一");
  bridge.defer("om_g2", "oc_g2", "二");

  const stranded = bridge.takeAllDeferred();
  assert.equal(stranded.length, 2, "静默丢掉的话，两个人都在等一个永远不来的回复");
  assert.equal(bridge.takeDeferred(), undefined);
});

// ── pi 的运行还没结束，但飞书流已经收尾的那段窗口 ────────────────────

test("agent_end 之后 pi 仍可能在忙，isAgentActive 要撑到 settled", async () => {
  // pi 的 _isAgentRunActive 是在 agent_settled 之前才置 false 的；
  // agent_end 之后还可能自动重试、压缩上下文，这段时间不带 deliverAs 直接发
  // 会被 prompt() 抛 "Agent is already processing"，消息就丢了
  const bridge = new Bridge(MULTI, targetTrackingGateway(emptySink()), () => {}, () => 0, 1000);

  claimFrom(bridge, "oc_dm");
  bridge.startTurn();
  assert.equal(bridge.isAgentActive, true);

  await bridge.endTurn();
  assert.equal(bridge.isStreaming, false, "飞书流已收尾");
  assert.equal(bridge.isAgentActive, true, "但 pi 还没 settled，此时直接发会抛");

  bridge.settleAgent();
  assert.equal(bridge.isAgentActive, false);
});

test("窗口期内来自别的对话的消息仍然要扣住", async () => {
  const bridge = new Bridge(MULTI, targetTrackingGateway(emptySink()), () => {}, () => 0, 1000);
  claimFrom(bridge, "oc_dm");
  bridge.startTurn();
  await bridge.endTurn();

  assert.equal(bridge.shouldDefer(inboundFrom(bridge, "oc_group")), true, "窗口期放行会把答案发错地方");
  assert.equal(bridge.turnTarget, "oc_dm", "窗口期要仍然知道上一轮发往哪儿");
});

test("settled 之后恢复正常，不再扣任何消息", async () => {
  const bridge = new Bridge(MULTI, targetTrackingGateway(emptySink()), () => {}, () => 0, 1000);
  claimFrom(bridge, "oc_dm");
  bridge.startTurn();
  await bridge.endTurn();
  bridge.settleAgent();

  assert.equal(bridge.shouldDefer(inboundFrom(bridge, "oc_group")), false);
  assert.equal(bridge.turnTarget, undefined);
});

test("一次运行里的自动重试会开多个回合，settled 只来一次", async () => {
  // pi 的 _handlePostAgentRun 会用 agent.continue() 再开一轮，
  // 于是 agent_start/agent_end 成对出现多次，agent_settled 只有一次
  const bridge = new Bridge(MULTI, targetTrackingGateway(emptySink()), () => {}, () => 0, 1000);
  claimFrom(bridge, "oc_dm");

  bridge.startTurn();
  await bridge.endTurn();
  bridge.startTurn();
  await bridge.endTurn();
  assert.equal(bridge.isAgentActive, true, "中间那次 agent_end 不代表 pi 闲下来了");

  bridge.settleAgent();
  assert.equal(bridge.isAgentActive, false);
});

// ── 消息级来源登记：出站按 messageId 回查，不再靠「最近一条是谁」 ──────

test("两条消息先后进来，先跑的那个回合回给先说话的那个", async () => {
  // #lastOrigin 时代这里必错：B 一到就把 A 覆盖掉，A 的回合会回给 B。
  // 按原文认领之后，谁触发的回合就查回谁
  const sink = emptySink();
  const bridge = new Bridge(MULTI, targetTrackingGateway(sink), () => {}, () => 0, 1000);

  bridge.recordInbound({ messageId: "om_A", chatId: "oc_私聊", senderId: "ou_1" });
  bridge.noteInboundPrompt("om_A", "先问的这句");
  bridge.recordInbound({ messageId: "om_B", chatId: "oc_群", senderId: "ou_2" });
  bridge.noteInboundPrompt("om_B", "后问的那句");

  // pi 先跑 A
  bridge.claimTurnOrigin("先问的这句");
  bridge.startTurn();
  await bridge.endTurn();
  bridge.settleAgent();

  bridge.claimTurnOrigin("后问的那句");
  bridge.startTurn();
  await bridge.endTurn();

  assert.deepEqual(sink.streams, ["oc_私聊", "oc_群"]);
});

test("终端敲的字认领不到消息，退回已绑定会话", async () => {
  const sink = emptySink();
  const gw = { ...targetTrackingGateway(sink), boundChatId: "oc_私聊" };
  const bridge = new Bridge(MULTI, gw, () => {}, () => 0, 1000);

  bridge.recordInbound({ messageId: "om_A", chatId: "oc_群", senderId: "ou_1" });
  bridge.noteInboundPrompt("om_A", "群里问的");
  bridge.claimTurnOrigin("群里问的");
  bridge.startTurn();
  await bridge.endTurn();
  bridge.settleAgent();

  // 终端敲的原文对不上任何登记过的消息
  bridge.claimTurnOrigin("我在终端敲的");
  bridge.startTurn();
  await bridge.endTurn();

  assert.deepEqual(sink.streams, ["oc_群", "oc_私聊"], "终端那轮该回落到已绑定会话");
});

test("并入当前 run 的 steer 不留认领索引，不能抢走后来同文问题的卡片", () => {
  const bridge = new Bridge(MULTI, targetTrackingGateway(emptySink()), () => {}, () => 0, 1000);

  bridge.recordInbound({ messageId: "om_steer", chatId: "oc_dm", senderId: "ou_1", text: "!继续" });
  bridge.noteInboundPrompt("om_steer", "继续", "steer");
  bridge.recordInbound({ messageId: "om_next", chatId: "oc_dm", senderId: "ou_1", text: "继续" });
  bridge.noteInboundPrompt("om_next", "继续");

  bridge.claimTurnOrigin("继续");
  assert.equal(bridge.originMessageId, "om_next");
});

test("一次运行里自动重试开多个回合，来源不能在 endTurn 就被清掉", async () => {
  // before_agent_start 一次运行只发一次，认领关联要撑到 agent_settled
  const sink = emptySink();
  const bridge = new Bridge(MULTI, targetTrackingGateway(sink), () => {}, () => 0, 1000);

  claimFrom(bridge, "oc_群", "om_A", "群里问的");
  bridge.startTurn();
  await bridge.endTurn();
  bridge.startTurn(); // pi 自动重试，没有新的 before_agent_start
  await bridge.endTurn();

  assert.deepEqual(sink.streams, ["oc_群", "oc_群"]);
});

test("一次运行里的自动重试仍在每张新卡片带上原问题", async () => {
  const cards: string[] = [];
  const bridge = new Bridge(
    MULTI,
    fakeGateway({
      async streamTurn(run) {
        const at = cards.push("") - 1;
        await run({ async append(chunk) { cards[at] += chunk; } });
      },
    }),
    () => {},
    () => 0,
    1000,
  );
  claimFrom(bridge, "oc_群", "om_retry", "原问题", "原问题");

  bridge.startTurn();
  await bridge.endTurn();
  bridge.startTurn();
  await bridge.endTurn();

  assert.equal(cards.length, 2);
  assert.equal(cards.every((card) => card.startsWith("> 💬 问题：原问题\n\n")), true);
});

test("单会话档不查登记表，出站一律走已绑定会话", async () => {
  // 向后兼容：multiChat 关着时行为与改造前一致
  const sink = emptySink();
  const gw = { ...targetTrackingGateway(sink), boundChatId: "oc_绑定的" };
  const bridge = new Bridge(CONFIG, gw, () => {}, () => 0, 1000);

  claimFrom(bridge, "oc_别处", "om_A", "随便一句");
  bridge.startTurn();
  await bridge.endTurn();

  assert.deepEqual(sink.streams, ["oc_绑定的"]);
});

test("审批卡片弹回触发这次工具调用的那个对话", async () => {
  const sink = emptySink();
  const bridge = new Bridge(MULTI, targetTrackingGateway(sink), () => {}, () => 0, 1000);

  claimFrom(bridge, "oc_群", "om_A", "把这个删了");
  bridge.startTurn();
  bridge.origins.bindToolCall("tc_1", bridge.originMessageId);
  await bridge.gateToolCall("bash", { command: "rm -rf a" }, undefined, "tc_1");

  assert.deepEqual(sink.asks, ["oc_群"]);
});

test("没绑过的工具调用退回本回合的目标，不会漏到别处", async () => {
  const sink = emptySink();
  const bridge = new Bridge(MULTI, targetTrackingGateway(sink), () => {}, () => 0, 1000);

  claimFrom(bridge, "oc_群", "om_A", "把这个删了");
  bridge.startTurn();
  await bridge.gateToolCall("bash", { command: "rm -rf a" }, undefined, "tc_没绑过");

  assert.deepEqual(sink.asks, ["oc_群"]);
});

// ── 话题（thread）：回复要落回提问的那个话题 ────────────────────────

/** 记录完整的出站目标，而不是压成 chatId —— 话题信息正是要验的那部分 */
function fullTargetGateway(sink: { streams: unknown[]; asks: unknown[] }): GatewayLike {
  return {
    bind() {},
    onMessage() {},
    async streamTurn(run, to) {
      sink.streams.push(to);
      await run({ async append() {} });
    },
    async sendText() {},
    async downloadImage() {
      return undefined;
    },
    askerFor(to) {
      return async () => {
        sink.asks.push(to);
        return { allow: false, reason: "未接线" };
      };
    },
  };
}

test("话题里提问：回合的出站目标带 replyTo 和 inThread", () => {
  const sink = { streams: [] as unknown[], asks: [] as unknown[] };
  const bridge = new Bridge(MULTI, fullTargetGateway(sink), () => {}, () => 0, 1000);

  bridge.recordInbound({ messageId: "om_t", chatId: "oc_g", senderId: "ou_1", threadId: "omt_9" });
  bridge.noteInboundPrompt("om_t", "话题里问的");
  bridge.claimTurnOrigin("话题里问的");
  bridge.startTurn();

  assert.deepEqual(sink.streams, [{ chatId: "oc_g", replyTo: "om_t", inThread: true }]);
});

test("默认单会话档的话题回复也保留 replyTo 和 inThread", () => {
  const sink = { streams: [] as unknown[], asks: [] as unknown[] };
  const gw = { ...fullTargetGateway(sink), boundChatId: "oc_g" };
  const bridge = new Bridge(CONFIG, gw, () => {}, () => 0, 1000);

  bridge.recordInbound({
    messageId: "om_t",
    chatId: "oc_g",
    senderId: "ou_1",
    threadId: "omt_9",
  });
  bridge.noteInboundPrompt("om_t", "话题里问的");
  bridge.claimTurnOrigin("话题里问的");
  bridge.startTurn();

  assert.deepEqual(sink.streams, [{ chatId: "oc_g", replyTo: "om_t", inThread: true }]);
});

test("普通群提问：出站目标只有 chatId，与加话题之前一致", () => {
  const sink = { streams: [] as unknown[], asks: [] as unknown[] };
  const bridge = new Bridge(MULTI, fullTargetGateway(sink), () => {}, () => 0, 1000);

  claimFrom(bridge, "oc_g", "om_p", "普通群问的");
  bridge.startTurn();

  assert.deepEqual(sink.streams, [{ chatId: "oc_g" }]);
});

test("终端敲字发起的回合：退回已绑定会话，不带话题", () => {
  const sink = { streams: [] as unknown[], asks: [] as unknown[] };
  const gw = { ...fullTargetGateway(sink), boundChatId: "oc_bound" };
  const bridge = new Bridge(MULTI, gw, () => {}, () => 0, 1000);

  bridge.claimTurnOrigin("我在终端敲的");
  bridge.startTurn();

  assert.deepEqual(sink.streams, [{ chatId: "oc_bound" }]);
});
