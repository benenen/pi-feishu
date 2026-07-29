import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APPROVAL_KIND,
  ApprovalRegistry,
  askViaCard,
  buildApprovalCard,
  buildSettledCard,
  handleCardAction,
  parseApprovalAction,
  resolveTarget,
} from "../extensions/feishu/approval-card.ts";

const REQ = { toolName: "bash", input: { command: "rm -rf /tmp/x" } };

test("审批卡片带三个按钮，value 结构可被自己解析回来", () => {
  const card = buildApprovalCard("ap-1", REQ) as {
    elements: { tag: string; actions?: { value: unknown }[] }[];
  };
  const action = card.elements.find((e) => e.tag === "action");
  assert.ok(action?.actions, "应有 action 元素");
  assert.equal(action.actions.length, 3);

  const [allow, turn, deny] = action.actions.map((a) => parseApprovalAction(a.value));
  assert.deepEqual(allow, { id: "ap-1", allow: true });
  assert.deepEqual(turn, { id: "ap-1", allow: true, scope: "turn" });
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
  const pending = reg.register("ap-1", "om_100", "oc_1");
  assert.equal(reg.size, 1);

  const messageId = reg.settle("ap-1", { allow: true, reason: "飞书批准" });
  assert.equal(messageId, "om_100");
  assert.deepEqual(await pending, { allow: true, reason: "飞书批准" });
  assert.equal(reg.size, 0, "兑现后应从登记表移除");
});

test("registry：重复 settle 返回 undefined，不会二次兑现", async () => {
  const reg = new ApprovalRegistry();
  const pending = reg.register("ap-1", "om_100", "oc_1");
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
  const a = reg.register("ap-1", "om_1", "oc_1");
  const b = reg.register("ap-2", "om_2", "oc_1");
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
  const a = reg.register("ap-1", "om_1", "oc_1");
  const b = reg.register("ap-2", "om_2", "oc_1");
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

test("卡片正文中和反引号，防止伪造出无害的渲染", () => {
  const evil = "ls\n```\n**看起来人畜无害**\n```\nrm -rf /";
  const json = JSON.stringify(buildApprovalCard("ap-1", { toolName: "bash", input: { command: evil } }));
  assert.ok(json.includes("rm -rf /"), "真正的命令必须仍然可见");
  assert.equal(json.includes("\\u0060\\u0060\\u0060") || json.includes("```"), true);
  // 正文里除了包裹用的围栏，不应再有反引号
  const body = JSON.parse(json).elements[0].text.content as string;
  const inner = body.slice(4, -4);
  assert.equal(inner.includes("`"), false, "命令内的反引号应已被中和");
});

test("卡片正文按码点截断，不会切碎 emoji 导致整张卡片发不出去", () => {
  const json = JSON.stringify(
    buildApprovalCard("ap-1", { toolName: "bash", input: { command: "😀".repeat(2000) } }),
  );
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  assert.equal(lone.test(json), false);
});

test("卡片带「本回合全部允许」按钮，动作里标出 scope", () => {
  const card = buildApprovalCard("ap-1", { toolName: "bash", input: { command: "rm -rf a" } }) as {
    elements: { tag: string; actions?: { text: { content: string }; value: unknown }[] }[];
  };
  const actions = card.elements.find((e) => e.tag === "action")?.actions ?? [];
  const turnBtn = actions.find((a) => a.text.content === "本回合全部允许");
  assert.ok(turnBtn, "应该有第三个按钮");
  assert.deepEqual(parseApprovalAction(turnBtn?.value), { id: "ap-1", allow: true, scope: "turn" });
});

test("普通允许/拒绝不带 scope", () => {
  assert.deepEqual(
    parseApprovalAction({ kind: APPROVAL_KIND, id: "ap-1", allow: true }),
    { id: "ap-1", allow: true },
  );
});

test("伪造的 scope 值不被接受 —— 只认字面量 turn", () => {
  assert.deepEqual(
    parseApprovalAction({ kind: APPROVAL_KIND, id: "ap-1", allow: true, scope: "session" }),
    { id: "ap-1", allow: true },
  );
});

// ---------------------------------------------------------------------------
// 卡片点击的鉴权 —— direct 与 broker 两档共用同一份实现
// ---------------------------------------------------------------------------

/** 构造一个卡片点击事件 */
function click(
  chatId: string,
  openId: string,
  value: unknown,
): { chatId: string; operator: { openId: string }; action: { value: unknown } } {
  return { chatId, operator: { openId }, action: { value } };
}

const ALLOW_VALUE = { kind: APPROVAL_KIND, id: "ap-1", allow: true };

/** 从一张审批卡片里取出「允许」按钮携带的审批 id */
function cardActionId(card: object | undefined): string {
  const parsed = JSON.parse(JSON.stringify(card)) as {
    elements: { actions?: { value: { id: string } }[] }[];
  };
  const id = parsed.elements.find((e) => e.actions)?.actions?.[0]?.value.id;
  assert.ok(id !== undefined && id.startsWith("ap-"), "卡片里的审批 id 应是随机的 ap-xxx");
  return id;
}

test("registry：点击来自另一个会话时拒绝兑现 —— 卡片发给谁，就只认谁那边的点击", async () => {
  const reg = new ApprovalRegistry();
  const pending = reg.register("ap-1", "om_1", "oc_X");
  assert.equal(
    reg.settle("ap-1", { allow: true, reason: "冒名" }, "oc_Y"),
    undefined,
    "来源会话对不上就不该兑现",
  );
  assert.equal(reg.size, 1, "被拒绝的兑现不能把登记项摘掉");

  assert.equal(reg.settle("ap-1", { allow: false, reason: "本尊" }, "oc_X"), "om_1");
  assert.deepEqual(await pending, { allow: false, reason: "本尊" });
});

test("registry：不传来源会话时不做这层校验 —— 内部撤销（cancel/cancelAll）走的就是这条", async () => {
  const reg = new ApprovalRegistry();
  const pending = reg.register("ap-1", "om_1", "oc_X");
  assert.equal(reg.cancel("ap-1", { allow: false, reason: "会话已结束" }), "om_1");
  assert.equal((await pending).reason, "会话已结束");
});

test("卡片鉴权：非授权审批人的点击一律忽略，并留一条 warning", async () => {
  const reg = new ApprovalRegistry();
  const pending = reg.register("ap-1", "om_1", "oc_X");
  const logs: string[] = [];
  const out = handleCardAction({
    registry: reg,
    event: click("oc_X", "ou_路人", ALLOW_VALUE),
    approverAllowlist: ["ou_审批人"],
    log: (m) => logs.push(m),
  });
  assert.equal(out, undefined);
  assert.equal(reg.size, 1, "不能被兑现");
  assert.ok(logs.some((l) => l.includes("ou_路人")));
  void pending;
});

test("卡片鉴权：broker 档也要校验会话 —— 点击必须来自卡片发往的那个对话", () => {
  const reg = new ApprovalRegistry();
  reg.register("ap-1", "om_1", "oc_X");
  const logs: string[] = [];
  // broker 档不传 requireBoundChat（一个 broker 服务多个对话，「当前绑定」
  // 是每个 pi 会话各自的概念）——但登记时记下的 chatId 这层必须在
  const out = handleCardAction({
    registry: reg,
    event: click("oc_Y", "ou_审批人", ALLOW_VALUE),
    approverAllowlist: ["ou_审批人"],
    log: (m) => logs.push(m),
  });
  assert.equal(out, undefined);
  assert.equal(reg.size, 1, "不能被兑现");
  assert.ok(logs.some((l) => l.includes("oc_Y")), "要留痕");
});

test("卡片鉴权：direct 档额外要求点击来自当前绑定的会话", () => {
  const reg = new ApprovalRegistry();
  reg.register("ap-1", "om_1", "oc_X");
  const logs: string[] = [];
  // 卡片发往 oc_X，点击也来自 oc_X，但会话已经改绑到 oc_Y —— direct 档拒
  const out = handleCardAction({
    registry: reg,
    event: click("oc_X", "ou_审批人", ALLOW_VALUE),
    approverAllowlist: ["ou_审批人"],
    requireBoundChat: true,
    boundChatId: "oc_Y",
    log: (m) => logs.push(m),
  });
  assert.equal(out, undefined);
  assert.equal(reg.size, 1);
  assert.ok(logs.some((l) => l.includes("oc_X")));
});

test("卡片鉴权：direct 档未绑定任何会话时，所有点击都拒", () => {
  const reg = new ApprovalRegistry();
  reg.register("ap-1", "om_1", "oc_X");
  const out = handleCardAction({
    registry: reg,
    event: click("oc_X", "ou_审批人", ALLOW_VALUE),
    approverAllowlist: ["ou_审批人"],
    requireBoundChat: true,
    boundChatId: undefined,
    log: () => {},
  });
  assert.equal(out, undefined);
  assert.equal(reg.size, 1);
});

test("卡片鉴权：合法点击兑现审批，并交回该收尾的卡片与文案", async () => {
  const reg = new ApprovalRegistry();
  const pending = reg.register("ap-1", "om_1", "oc_X");
  const out = handleCardAction({
    registry: reg,
    event: click("oc_X", "ou_审批人", ALLOW_VALUE),
    approverAllowlist: ["ou_审批人"],
    requireBoundChat: true,
    boundChatId: "oc_X",
    log: () => {},
  });
  assert.deepEqual(out, { messageId: "om_1", status: "已批准" });
  assert.deepEqual(await pending, { allow: true, reason: "飞书批准" });
});

test("卡片鉴权：「本回合全部允许」带出 scope，文案也要跟着变", async () => {
  const reg = new ApprovalRegistry();
  const pending = reg.register("ap-1", "om_1", "oc_X");
  const out = handleCardAction({
    registry: reg,
    event: click("oc_X", "ou_审批人", { kind: APPROVAL_KIND, id: "ap-1", allow: true, scope: "turn" }),
    approverAllowlist: ["ou_审批人"],
    log: () => {},
  });
  assert.deepEqual(out, { messageId: "om_1", status: "已批准（本回合全部允许）" });
  assert.deepEqual(await pending, {
    allow: true,
    reason: "飞书批准（本回合全部允许）",
    scope: "turn",
  });
});

test("卡片鉴权：拒绝按钮兑现成拒绝", async () => {
  const reg = new ApprovalRegistry();
  const pending = reg.register("ap-1", "om_1", "oc_X");
  const out = handleCardAction({
    registry: reg,
    event: click("oc_X", "ou_审批人", { kind: APPROVAL_KIND, id: "ap-1", allow: false }),
    approverAllowlist: ["ou_审批人"],
    log: () => {},
  });
  assert.deepEqual(out, { messageId: "om_1", status: "已拒绝" });
  assert.equal((await pending).allow, false);
});

test("卡片鉴权：不属于本扩展的 value 直接忽略，连鉴权都不用走", () => {
  const out = handleCardAction({
    registry: new ApprovalRegistry(),
    event: click("oc_X", "ou_路人", { kind: "别的扩展" }),
    approverAllowlist: [],
    log: () => {},
  });
  assert.equal(out, undefined);
});

// ---------------------------------------------------------------------------
// askViaCard —— direct 的 cardAsker 与 broker 的 askCard 共用的那段
// ---------------------------------------------------------------------------

test("askViaCard：发出卡片、登记未决，被兑现后返回裁决", async () => {
  const reg = new ApprovalRegistry();
  const sent: Array<{ chatId: string; card: object }> = [];
  const settled: Array<{ messageId: string; status: string }> = [];
  const decision = askViaCard({
    registry: reg,
    chatId: "oc_X",
    req: REQ,
    signal: new AbortController().signal,
    send: async (chatId, card) => {
      sent.push({ chatId, card });
      return "om_1";
    },
    settleCard: async (messageId, status) => void settled.push({ messageId, status }),
  });

  // 等 send 走完、登记完成
  for (let i = 0; i < 50 && reg.size === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.equal(reg.size, 1, "卡片发出后应登记为未决");
  assert.equal(sent[0]?.chatId, "oc_X");

  const id = cardActionId(sent[0]?.card);
  reg.settle(id, { allow: true, reason: "飞书批准" }, "oc_X");
  assert.deepEqual(await decision, { allow: true, reason: "飞书批准" });
  assert.deepEqual(settled, [], "被人点掉的卡片由调用方收尾，不在这里");
});

test("askViaCard：竞速已结束（signal 已 abort）时连卡片都不发", async () => {
  const ac = new AbortController();
  ac.abort();
  let sends = 0;
  const d = await askViaCard({
    registry: new ApprovalRegistry(),
    chatId: "oc_X",
    req: REQ,
    signal: ac.signal,
    send: async () => {
      sends += 1;
      return "om_1";
    },
    settleCard: async () => {},
  });
  assert.deepEqual(d, { allow: false, reason: "已由其他通道处理" });
  assert.equal(sends, 0, "已经作废了就别再往飞书发卡片");
});

test("askViaCard：卡片还在发送途中就被别的通道抢先 —— 发出后立刻收到终态", async () => {
  const ac = new AbortController();
  const reg = new ApprovalRegistry();
  const settled: Array<{ messageId: string; status: string }> = [];
  const d = await askViaCard({
    registry: reg,
    chatId: "oc_X",
    req: REQ,
    signal: ac.signal,
    send: async () => {
      // 卡片发出去之前终端那边就批了
      ac.abort();
      return "om_1";
    },
    settleCard: async (messageId, status) => void settled.push({ messageId, status }),
  });
  assert.deepEqual(d, { allow: false, reason: "已由其他通道处理" });
  assert.deepEqual(settled, [{ messageId: "om_1", status: "已在终端处理" }]);
  assert.equal(reg.size, 0, "作废的卡片不该留在登记表里");
});

test("askViaCard：卡片已登记之后才被抢先 —— 撤销登记并收尾卡片", async () => {
  const ac = new AbortController();
  const reg = new ApprovalRegistry();
  const settled: Array<{ messageId: string; status: string }> = [];
  const decision = askViaCard({
    registry: reg,
    chatId: "oc_X",
    req: REQ,
    signal: ac.signal,
    send: async () => "om_1",
    settleCard: async (messageId, status) => void settled.push({ messageId, status }),
  });
  for (let i = 0; i < 50 && reg.size === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.equal(reg.size, 1);

  ac.abort();
  assert.deepEqual(await decision, { allow: false, reason: "已由其他通道处理" });
  for (let i = 0; i < 50 && settled.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(settled, [{ messageId: "om_1", status: "已在终端处理" }]);
});

test("askViaCard：登记时记下收件会话，别的会话点不动这张卡片", async () => {
  const reg = new ApprovalRegistry();
  let card: object | undefined;
  const decision = askViaCard({
    registry: reg,
    chatId: "oc_X",
    req: REQ,
    signal: new AbortController().signal,
    send: async (_chatId, c) => {
      card = c;
      return "om_1";
    },
    settleCard: async () => {},
  });
  for (let i = 0; i < 50 && reg.size === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
  const id = cardActionId(card);

  // 走完整链路：id 对得上、审批人也在名单里，唯独来源会话不是卡片发往的那个
  const wrongChat = handleCardAction({
    registry: reg,
    event: click("oc_Y", "ou_审批人", { kind: APPROVAL_KIND, id, allow: true }),
    approverAllowlist: ["ou_审批人"],
    log: () => {},
  });
  assert.equal(wrongChat, undefined);
  assert.equal(reg.size, 1, "仍然未决");

  // 同一个 id、同一个人，来源会话对上就能兑现 —— 证明上面拦的确实是会话这一层
  const rightChat = handleCardAction({
    registry: reg,
    event: click("oc_X", "ou_审批人", { kind: APPROVAL_KIND, id, allow: true }),
    approverAllowlist: ["ou_审批人"],
    log: () => {},
  });
  assert.deepEqual(rightChat, { messageId: "om_1", status: "已批准" });
  assert.equal((await decision).allow, true);
});
