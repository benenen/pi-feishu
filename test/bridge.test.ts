import { test } from "node:test";
import assert from "node:assert/strict";
import {
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
  dmAllowlist: ["ou_1"],
  groupAllowlist: [],
  approverAllowlist: ["ou_1"],
  requireMention: true,
  approvalMode: "balanced" as const,
  approvalTimeoutMs: 1000,
  repoRoot: "/work/repo",
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
