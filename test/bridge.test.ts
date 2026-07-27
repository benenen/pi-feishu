import { test } from "node:test";
import assert from "node:assert/strict";
import { decideDelivery, parseControlCommand, shouldAccept } from "../extensions/feishu/bridge.ts";

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
