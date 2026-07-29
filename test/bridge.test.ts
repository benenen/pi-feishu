import { test } from "node:test";
import assert from "node:assert/strict";
import {
  announceAndBind,
  bindToChat,
  Bridge,
  decideDelivery,
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
    cardAsker: async () => ({ allow: false, reason: "未接线" }),
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
      cardAsker: async () => {
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
    cardAsker: async () => {
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
      cardAsker: async () => {
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
      cardAsker: async () => {
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
