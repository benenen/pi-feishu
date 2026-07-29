import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "../extensions/feishu/broker/registry.ts";

/** 固定随机源，码可预期；固定时钟，过期可控 */
function makeRegistry(now = () => 0) {
  let n = 0;
  return new SessionRegistry({
    now,
    randomInt: () => (n++ % 31),
    pairingTtlMs: 600_000,
  });
}

const A = { id: "s1", label: "项目A", cwd: "/a" };
const B = { id: "s2", label: "项目B", cwd: "/b" };

test("绑定后能按 chatId 找回会话", () => {
  const r = makeRegistry();
  r.add(A);
  r.bind("s1", "oc_1");
  assert.equal(r.byChat("oc_1")?.id, "s1");
  assert.equal(r.boundChatOf("s1"), "oc_1");
});

test("未绑定的 chatId 查不到会话", () => {
  const r = makeRegistry();
  r.add(A);
  assert.equal(r.byChat("oc_unknown"), undefined);
});

test("配对码匹配后返回该会话，且完成绑定", () => {
  const r = makeRegistry();
  r.add(A);
  const code = r.issueCode("s1");
  assert.equal(r.matchCode(code)?.id, "s1");
  // matchCode 只负责认人，绑定由调用方带 chatId 做
  r.bind("s1", "oc_9");
  assert.equal(r.byChat("oc_9")?.id, "s1");
});

test("配对码是一次性的", () => {
  const r = makeRegistry();
  r.add(A);
  const code = r.issueCode("s1");
  assert.equal(r.matchCode(code)?.id, "s1");
  assert.equal(r.matchCode(code), undefined, "第二次不该再认");
});

test("两个会话各自的码互不串台", () => {
  const r = makeRegistry();
  r.add(A);
  r.add(B);
  const ca = r.issueCode("s1");
  const cb = r.issueCode("s2");
  assert.notEqual(ca, cb);
  assert.equal(r.matchCode(cb)?.id, "s2");
  assert.equal(r.matchCode(ca)?.id, "s1");
});

test("一个 chatId 只能绑一个会话：后绑的把先绑的顶掉", () => {
  const r = makeRegistry();
  r.add(A);
  r.add(B);
  r.bind("s1", "oc_1");
  r.bind("s2", "oc_1");
  assert.equal(r.byChat("oc_1")?.id, "s2");
  assert.equal(r.boundChatOf("s1"), undefined, "被顶掉的会话应视为未绑定");
});

test("一个会话换绑新 chatId 时，旧 chatId 的路由要清掉", () => {
  const r = makeRegistry();
  r.add(A);
  r.bind("s1", "oc_1");
  r.bind("s1", "oc_2");
  assert.equal(r.byChat("oc_1"), undefined, "旧路由必须清掉，否则消息投给一个不再关心它的会话");
  assert.equal(r.byChat("oc_2")?.id, "s1");
});

test("会话断开时，它的绑定与待配对码一并清除", () => {
  const r = makeRegistry();
  r.add(A);
  const code = r.issueCode("s1");
  r.bind("s1", "oc_1");
  r.remove("s1");
  assert.equal(r.byChat("oc_1"), undefined);
  assert.equal(r.matchCode(code), undefined, "断开会话的码不能还能用");
  assert.equal(r.byId("s1"), undefined);
});

test("配对码过期后不再匹配", () => {
  let t = 0;
  let n = 0;
  const r = new SessionRegistry({
    now: () => t,
    randomInt: () => (n++ % 31),
    pairingTtlMs: 1000,
  });
  r.add(A);
  const code = r.issueCode("s1");
  t = 1001;
  assert.equal(r.matchCode(code), undefined);
});

test("重新签发作废旧码", () => {
  const r = makeRegistry();
  r.add(A);
  const first = r.issueCode("s1");
  const second = r.issueCode("s1");
  assert.equal(r.matchCode(first), undefined);
  assert.equal(r.matchCode(second)?.id, "s1");
});

test("list 列出全部会话及其绑定", () => {
  const r = makeRegistry();
  r.add(A);
  r.add(B);
  r.bind("s1", "oc_1");
  const rows = r.list();
  assert.equal(rows.length, 2);
  assert.equal(rows.find((x) => x.id === "s1")?.chatId, "oc_1");
  assert.equal(rows.find((x) => x.id === "s2")?.chatId, undefined);
});
