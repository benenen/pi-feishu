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
  readReceiptEmoji: "EYES",
  approvalMode: "balanced" as const,
  denyPatterns: [],
  allowPatterns: [],
  approvalTimeoutMs: 1000,
  repoRoot: "/work/repo",
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
      sink.streams.push(to);
      await run({ async append() {} });
    },
    async sendText(text, to) {
      sink.texts.push({ text, to });
    },
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

const MULTI = { ...CONFIG, multiChat: true };

test("多会话：两个回合分别流回各自的来源", async () => {
  const sink = { streams: [] as (string | undefined)[], texts: [], asks: [] };
  const bridge = new Bridge(MULTI, targetTrackingGateway(sink), () => {}, () => 0, 1000);

  bridge.noteInboundOrigin("oc_dm");
  bridge.startTurn();
  await bridge.endTurn();

  bridge.noteInboundOrigin("oc_group");
  bridge.startTurn();
  await bridge.endTurn();

  assert.deepEqual(sink.streams, ["oc_dm", "oc_group"]);
});

test("终端发起的回合没有来源，流到默认收件方（undefined）", async () => {
  const sink = { streams: [] as (string | undefined)[], texts: [], asks: [] };
  const bridge = new Bridge(MULTI, targetTrackingGateway(sink), () => {}, () => 0, 1000);

  bridge.startTurn(); // 没有 noteInboundOrigin
  await bridge.endTurn();

  assert.deepEqual(sink.streams, [undefined], "退回网关的默认收件方，而不是乱发给上一个来源");
});

test("来源按 FIFO 出队，不会串到别的回合", async () => {
  const sink = { streams: [] as (string | undefined)[], texts: [], asks: [] };
  const bridge = new Bridge(MULTI, targetTrackingGateway(sink), () => {}, () => 0, 1000);

  // 两条消息先后排队（followUp 场景），回合再依次开
  bridge.noteInboundOrigin("oc_a");
  bridge.noteInboundOrigin("oc_b");
  bridge.startTurn();
  await bridge.endTurn();
  bridge.startTurn();
  await bridge.endTurn();

  assert.deepEqual(sink.streams, ["oc_a", "oc_b"]);
});

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

  bridge.noteInboundOrigin("oc_group");
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

  bridge.noteInboundOrigin("oc_group");
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

test("终端在空闲时开的回合占用自己的槽位，不会认领飞书来源", async () => {
  const sink = { streams: [] as (string | undefined)[], texts: [], asks: [] };
  const bridge = new Bridge(MULTI, targetTrackingGateway(sink), () => {}, () => 0, 1000);

  // 空闲时敲终端 —— 这一下会立刻开一个回合，必须占掉一个槽位
  bridge.onUserPrompt("看下日志", "interactive");
  // 紧接着飞书私聊来了一条
  bridge.noteInboundOrigin("oc_dm");

  bridge.startTurn();           // 终端那个回合
  await bridge.endTurn();
  bridge.startTurn();           // 飞书那条的回合
  await bridge.endTurn();

  assert.deepEqual(
    sink.streams,
    [undefined, "oc_dm"],
    "终端不占槽位的话，它会认领掉 oc_dm，把终端的输出发进私聊，而私聊那条回落到已绑定会话",
  );
});

test("steer 消息不占用来源槽位 —— 它不产生新回合", async () => {
  const sink = { streams: [] as (string | undefined)[], texts: [], asks: [] };
  const bridge = new Bridge(MULTI, targetTrackingGateway(sink), () => {}, () => 0, 1000);

  bridge.noteInboundOrigin("oc_dm");
  bridge.startTurn(); // 认领 oc_dm
  // 回合进行中，群里 @ 了一句打断（steer）—— 不会开新回合
  bridge.onUserPrompt("!停一下", "feishu");
  await bridge.endTurn();

  // 下一个回合来自私聊
  bridge.noteInboundOrigin("oc_dm2");
  bridge.startTurn();
  await bridge.endTurn();

  assert.deepEqual(sink.streams, ["oc_dm", "oc_dm2"], "steer 压了槽位的话，这里会错位");
});

// ── 入站准入判定 ────────────────────────────────────────────────────

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
