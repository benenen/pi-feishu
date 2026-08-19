import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AgentOriginRegistry,
  dispatchedSessionOf,
  MAX_AGENT_ORIGINS,
  noticeSessionOf,
} from "../extensions/feishu/agent-origin.ts";

/** pi-asd 的工具返回长这样：`{ content: [...], details: {...} }` */
function result(details: unknown, extra: Record<string, unknown> = {}) {
  return { content: [{ type: "text", text: "…" }], details, ...extra };
}

// --- 认出「这次调用把活派给了哪个 session」 ---

test("asd_spawn 的返回里取出 session 名", () => {
  assert.equal(dispatchedSessionOf("asd_spawn", result({ session: "pi-a", agent: "claude" })), "pi-a");
});

test("steer / follow / nav 同样算派活 —— 它们之后照样会有 watcher 推送", () => {
  assert.equal(dispatchedSessionOf("asd_steer", result({ session: "pi-a" })), "pi-a");
  assert.equal(dispatchedSessionOf("asd_follow", result({ session: "pi-b" })), "pi-b");
  assert.equal(dispatchedSessionOf("asd_nav", result({ session: "pi-c" })), "pi-c");
});

test("asd_peek 不算 —— 只读一屏不会引出推送，重绑会把结果改道给只看了一眼的人", () => {
  assert.equal(dispatchedSessionOf("asd_peek", result({ session: "pi-a" })), undefined);
});

test("结束/改名/摘监视都不算派活", () => {
  assert.equal(dispatchedSessionOf("asd_kill", result({ session: "pi-a" })), undefined);
  assert.equal(dispatchedSessionOf("asd_unmonitor", result({ session: "pi-a" })), undefined);
  assert.equal(dispatchedSessionOf("asd_rename", result({ from: "pi-a", to: "pi-b" })), undefined);
});

test("不是 pi-asd 的工具一律不认，哪怕返回里恰好有个 session 字段", () => {
  assert.equal(dispatchedSessionOf("bash", result({ session: "pi-a" })), undefined);
  assert.equal(dispatchedSessionOf("read", result({ session: "pi-a" })), undefined);
});

test("投递未确认（isError）时仍然取 session —— 那条路径照样进台账、照样挂 watcher", () => {
  // pi-asd 的不变量 6：sendText 拿到 ACK 之后无论证据链成不成立都要保留控制权，
  // 所以这种失败返回之后仍然可能有推送发过来。
  assert.equal(
    dispatchedSessionOf("asd_spawn", result({ session: "pi-a", phase: "submit" }, { isError: true })),
    "pi-a",
  );
});

test("返回形状不对时不猜", () => {
  assert.equal(dispatchedSessionOf("asd_spawn", result(undefined)), undefined);
  assert.equal(dispatchedSessionOf("asd_spawn", result({})), undefined);
  assert.equal(dispatchedSessionOf("asd_spawn", result({ session: 42 })), undefined);
  assert.equal(dispatchedSessionOf("asd_spawn", result({ session: "  " })), undefined);
  assert.equal(dispatchedSessionOf("asd_spawn", undefined), undefined);
  assert.equal(dispatchedSessionOf("asd_spawn", "pi-a"), undefined);
});

// --- 认出 watcher 的推送 ---

test("pi-asd 的推送消息里取出 session 名", () => {
  const message = {
    role: "custom",
    customType: "pi-asd-agent",
    content: '[pi-asd] agent "pi-a" 已停下（历时 1m51s）。',
    details: { session: "pi-a" },
  };
  assert.equal(noticeSessionOf(message), "pi-a");
});

test("别的自定义消息不认 —— 认错就是把回合改道", () => {
  assert.equal(
    noticeSessionOf({ role: "custom", customType: "pi-feishu-notice", details: { session: "pi-a" } }),
    undefined,
  );
});

test("普通用户/助手消息不认", () => {
  assert.equal(noticeSessionOf({ role: "user", content: "看下天气" }), undefined);
  assert.equal(noticeSessionOf({ role: "assistant", content: "好的" }), undefined);
  assert.equal(noticeSessionOf(undefined), undefined);
});

test("老版本 pi-asd 不带 details 时不猜，退回默认路由", () => {
  // 正文里明明有 session 名，但正文是给模型读的、措辞随时会变，
  // 拿它做路由等于把一句中文当协议。
  assert.equal(
    noticeSessionOf({ role: "custom", customType: "pi-asd-agent", content: 'agent "pi-a" 已停下' }),
    undefined,
  );
});

// --- 登记表 ---

test("按 session 存取派活时的目标", () => {
  const origins = new AgentOriginRegistry();
  origins.bind("pi-a", { chatId: "oc_group" });
  assert.deepEqual(origins.targetOf("pi-a"), { chatId: "oc_group" });
});

test("没派过的 session 查不到 —— 由调用方退回默认收件方", () => {
  const origins = new AgentOriginRegistry();
  assert.equal(origins.targetOf("pi-a"), undefined);
  assert.equal(origins.targetOf(undefined), undefined);
});

test("同一个 session 再次派活时，以最近一次的来源为准", () => {
  const origins = new AgentOriginRegistry();
  origins.bind("pi-a", { chatId: "oc_dm" });
  origins.bind("pi-a", { chatId: "oc_group", replyTo: "om_1", inThread: true });
  assert.deepEqual(origins.targetOf("pi-a"), { chatId: "oc_group", replyTo: "om_1", inThread: true });
});

test("超过上限时淘汰最老的，不做慢性泄漏", () => {
  const origins = new AgentOriginRegistry();
  for (let i = 0; i < MAX_AGENT_ORIGINS + 5; i += 1) origins.bind(`pi-${i}`, { chatId: `oc_${i}` });

  assert.equal(origins.size, MAX_AGENT_ORIGINS);
  assert.equal(origins.targetOf("pi-0"), undefined, "最老的该被淘汰");
  assert.deepEqual(origins.targetOf(`pi-${MAX_AGENT_ORIGINS + 4}`), {
    chatId: `oc_${MAX_AGENT_ORIGINS + 4}`,
  });
});

test("重复 bind 同一个 session 不占额外名额", () => {
  const origins = new AgentOriginRegistry();
  origins.bind("pi-a", { chatId: "oc_1" });
  origins.bind("pi-a", { chatId: "oc_2" });
  assert.equal(origins.size, 1);
});
