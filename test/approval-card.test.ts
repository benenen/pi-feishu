import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APPROVAL_KIND,
  ApprovalRegistry,
  buildApprovalCard,
  buildSettledCard,
  parseApprovalAction,
  resolveTarget,
} from "../extensions/feishu/approval-card.ts";

const REQ = { toolName: "bash", input: { command: "rm -rf /tmp/x" } };

test("审批卡片带一对按钮，value 结构可被自己解析回来", () => {
  const card = buildApprovalCard("ap-1", REQ) as {
    elements: { tag: string; actions?: { value: unknown }[] }[];
  };
  const action = card.elements.find((e) => e.tag === "action");
  assert.ok(action?.actions, "应有 action 元素");
  assert.equal(action.actions.length, 2);

  const [allow, deny] = action.actions.map((a) => parseApprovalAction(a.value));
  assert.deepEqual(allow, { id: "ap-1", allow: true });
  assert.deepEqual(deny, { id: "ap-1", allow: false });
});

test("卡片正文包含被审批的命令", () => {
  const json = JSON.stringify(buildApprovalCard("ap-1", REQ));
  assert.ok(json.includes("rm -rf /tmp/x"));
});

test("超长命令被截断，避免撑爆卡片元素上限", () => {
  const long = { toolName: "bash", input: { command: "x".repeat(5000) } };
  const json = JSON.stringify(buildApprovalCard("ap-1", long));
  assert.ok(json.length < 2000, `卡片过大：${json.length}`);
});

test("无 command/path 的工具也能构造卡片", () => {
  const card = buildApprovalCard("ap-1", { toolName: "weird", input: { a: 1 } });
  assert.ok(JSON.stringify(card).includes("weird"));
});

test("parseApprovalAction 拒绝不属于本扩展的 value", () => {
  assert.equal(parseApprovalAction(undefined), undefined);
  assert.equal(parseApprovalAction({ kind: "other", id: "x", allow: true }), undefined);
  assert.equal(parseApprovalAction({ kind: APPROVAL_KIND, allow: true }), undefined, "缺 id");
  assert.equal(parseApprovalAction("nope"), undefined);
});

test("parseApprovalAction 把缺失/非布尔的 allow 视为拒绝", () => {
  assert.deepEqual(parseApprovalAction({ kind: APPROVAL_KIND, id: "a" }), {
    id: "a",
    allow: false,
  });
});

test("registry：settle 兑现对应的 promise 并交回 messageId", async () => {
  const reg = new ApprovalRegistry();
  const pending = reg.register("ap-1", "om_100");
  assert.equal(reg.size, 1);

  const messageId = reg.settle("ap-1", { allow: true, reason: "飞书批准" });
  assert.equal(messageId, "om_100");
  assert.deepEqual(await pending, { allow: true, reason: "飞书批准" });
  assert.equal(reg.size, 0, "兑现后应从登记表移除");
});

test("registry：重复 settle 返回 undefined，不会二次兑现", async () => {
  const reg = new ApprovalRegistry();
  const pending = reg.register("ap-1", "om_100");
  reg.settle("ap-1", { allow: true, reason: "第一次" });
  assert.equal(reg.settle("ap-1", { allow: false, reason: "第二次" }), undefined);
  assert.deepEqual(await pending, { allow: true, reason: "第一次" });
});

test("registry：settle 未知 id 是安全的空操作", () => {
  const reg = new ApprovalRegistry();
  assert.equal(reg.settle("nope", { allow: true, reason: "x" }), undefined);
});

test("registry：cancelAll 把所有未决审批一次性判为拒绝", async () => {
  const reg = new ApprovalRegistry();
  const a = reg.register("ap-1", "om_1");
  const b = reg.register("ap-2", "om_2");
  reg.cancelAll({ allow: false, reason: "会话已结束" });
  assert.equal(reg.size, 0);
  assert.equal((await a).allow, false);
  assert.equal((await b).reason, "会话已结束");
});

test("resolveTarget：显式收件方优先于已绑定会话", () => {
  assert.equal(resolveTarget("oc_bound", "oc_other"), "oc_other");
  assert.equal(resolveTarget("oc_bound", undefined), "oc_bound");
  assert.equal(resolveTarget(undefined, "oc_other"), "oc_other");
  assert.equal(resolveTarget(undefined, undefined), undefined, "都没有时不应发送");
});

test("registry：cancelAll 交回被撤销的 messageId，供调用方收尾卡片", async () => {
  const reg = new ApprovalRegistry();
  const a = reg.register("ap-1", "om_1");
  const b = reg.register("ap-2", "om_2");
  const stranded = reg.cancelAll({ allow: false, reason: "会话已结束" });
  assert.deepEqual(stranded.sort(), ["om_1", "om_2"]);
  assert.equal(reg.size, 0);
  assert.equal((await a).allow, false);
  assert.equal((await b).reason, "会话已结束");
});

test("registry：cancelAll 无未决审批时返回空数组", () => {
  assert.deepEqual(new ApprovalRegistry().cancelAll({ allow: false, reason: "x" }), []);
});

test("buildSettledCard 只剩状态文案，不再带按钮", () => {
  const card = buildSettledCard("已批准") as { elements: { tag: string }[] };
  assert.equal(card.elements.length, 1);
  assert.equal(card.elements.some((e) => e.tag === "action"), false, "不应残留可点按钮");
  assert.ok(JSON.stringify(card).includes("已批准"));
});

test("parseApprovalAction：非布尔的 allow 一律视为拒绝", () => {
  assert.deepEqual(parseApprovalAction({ kind: APPROVAL_KIND, id: "a", allow: "yes" }), {
    id: "a",
    allow: false,
  });
  assert.deepEqual(parseApprovalAction({ kind: APPROVAL_KIND, id: "a", allow: 1 }), {
    id: "a",
    allow: false,
  });
});

test("无 command/path 的工具，卡片正文回退到序列化 input", () => {
  const json = JSON.stringify(buildApprovalCard("ap-1", { toolName: "weird", input: { a: 1 } }));
  assert.ok(json.includes("weird"), "标题应含工具名");
  assert.ok(json.includes('{\\"a\\":1}'), "正文应含序列化后的 input");
});
