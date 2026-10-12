import { test } from "node:test";
import assert from "node:assert/strict";
import { BackgroundTools, installBackgroundToolHook, TOOL_EXECUTION_HOOK, type ToolResult } from "../extensions/feishu/background-tools.ts";
import type { SendTarget } from "../extensions/feishu/types.ts";

function deferred() {
  let resolve: (r: ToolResult) => void = () => {};
  let reject: (e: Error) => void = () => {};
  const promise = new Promise<ToolResult>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const result = (text: string): ToolResult => ({ content: [{ type: "text", text }], details: {} });
const to = { chatId: "原群", replyTo: "原问题", inThread: true };
function setup() {
  const sent: { text: string; to: SendTarget }[] = [];
  const service = new BackgroundTools({ waitMs: 5, onComplete: async (completion) => { sent.push({ text: completion.body, to: completion.to }); }, log: () => {} });
  return { service, sent };
}

test("等待期限后先返回登记回执；主 agent 可继续，watcher 完成再提交原话题的总结", async () => {
  const { service, sent } = setup();
  const work = deferred();
  try {
    const ack = await Promise.race([
      service.run({ id: "slow", name: "bash", to, execute: () => work.promise }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("主 agent 仍被慢工具阻塞")), 100)),
    ]);
    assert.match(ack.content[0].text ?? "", /后台|watcher/);
    assert.equal(sent.length, 0, "工具未完成时不能伪造结果");
    const next = await service.run({ id: "next", name: "mcp_query", to: { chatId: "其他群" }, execute: async () => result("继续处理") });
    assert.equal(next.content[0].text, "继续处理");
    work.resolve(result("PONG"));
    await service.drain();
    assert.deepEqual(sent[0].to, to);
    assert.match(sent[0].text, /PONG/);
    assert.equal(service.count, 0);
  } finally {
    work.resolve(result("收尾"));
    service.shutdown();
    await service.drain();
  }
});

test("短工具保留原结果与错误，不另发完成消息", async () => {
  const { service, sent } = setup();
  const expected = result("原结果");
  assert.equal(await service.run({ id: "short", name: "read", to, execute: async () => expected }), expected);
  await assert.rejects(service.run({ id: "bad", name: "read", to, execute: async () => { throw new Error("原错误"); } }), /原错误/);
  assert.deepEqual(sent, []);
});

test("脱离回合之后的 abort 不取消 watcher；桥接 shutdown 取消并抑制晚到结果", async () => {
  const { service, sent } = setup();
  const parent = new AbortController();
  const work = deferred();
  let signal: AbortSignal | undefined;
  await service.run({ id: "slow", name: "bash", to, signal: parent.signal, execute: (s) => { signal = s; return work.promise; } });
  parent.abort();
  assert.equal(signal?.aborted, false, "独立任务不跟着后来回合取消");
  service.shutdown();
  assert.equal(signal?.aborted, true);
  work.resolve(result("不该发出的结果"));
  await service.drain();
  assert.deepEqual(sent, []);
});

test("工具在同步等待期间取消，不能再登记后台任务或回传结果", async () => {
  const { service, sent } = setup();
  const parent = new AbortController();
  const work = deferred();
  const calling = service.run({ id: "cancel", name: "bash", to, signal: parent.signal, execute: () => work.promise });
  parent.abort();
  await assert.rejects(calling, /取消/);
  work.resolve(result("取消后的结果"));
  await service.drain();
  assert.deepEqual(sent, []);
  assert.equal(service.count, 0);
});

test("后台失败只提交失败资料；总结投递失败被兜住，不产生游离 rejection", async () => {
  const { service, sent } = setup();
  const work = deferred();
  await service.run({ id: "bad", name: "bash", to, execute: () => work.promise });
  work.reject(new Error("命令失败"));
  await service.drain();
  assert.match(sent[0].text, /失败/);
  assert.match(sent[0].text, /命令失败/);
  const logs: string[] = [];
  const broken = new BackgroundTools({ waitMs: 1, onComplete: async () => { throw new Error("断网"); }, log: (message) => { logs.push(message); } });
  const other = deferred();
  await broken.run({ id: "send", name: "bash", to, execute: () => other.promise });
  other.resolve(result("PONG"));
  await broken.drain();
  assert.match(logs.join("\n"), /断网/);
  assert.equal(broken.count, 0);
});


test("后台 MCP 只有结构化结果时仍提交总结资料", async () => {
  const { service, sent } = setup();
  const work = deferred();
  await service.run({ id: "structured", name: "mcp", to, execute: () => work.promise });
  work.resolve({ content: [], details: {}, structuredContent: { answer: "PONG" } } as ToolResult);
  await service.drain();
  assert.match(sent[0].text, /PONG/);
});

test("后台父任务的子工具保留完整返回；无飞书目标时按原路径执行", async () => {
  const { service, sent } = setup();
  const work = deferred();
  await service.run({ id: "parent", name: "codemode", to, execute: () => work.promise });
  const remove = installBackgroundToolHook(service, () => undefined);
  const hook = (globalThis as unknown as { [key: symbol]: Function })[TOOL_EXECUTION_HOOK];
  const child = deferred();
  try {
    const running = hook({ name: "child", execute: () => child.promise }, "parent/1", {});
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(service.count, 1, "子工具不能另建 watcher，把回执冒充结果送给父工具");
    const expected = result("子工具结果");
    child.resolve(expected);
    assert.equal(await running, expected);
    assert.deepEqual(service.targetOf("parent/1"), to);
    assert.equal(await hook({ name: "direct", execute: async () => expected }, "no-target", {}), expected);
    assert.deepEqual(sent, []);
  } finally {
    child.resolve(result("收尾"));
    work.resolve(result("父工具结果"));
    await service.drain();
    remove();
  }
});

test("状态快照与变化通知跟随后台执行、交付总结和清理，不把短工具冒充后台任务", async () => {
  let now = 0;
  const phases: string[][] = [];
  const service = new BackgroundTools({ waitMs: 5, now: () => now, onComplete: async () => {}, log: () => {}, onChange: () => { phases.push(service.watching().map((task) => task.phase)); } });
  const work = deferred();
  const calling = service.run({ id: "slow", name: "bash", question: "编译项目", to, execute: () => work.promise });
  assert.deepEqual(service.watching(), [], "同步等待阶段不计入后台列表");
  now = 65000;
  await calling;
  assert.deepEqual(service.watching(), [{ id: "slow", name: "bash", question: "编译项目", elapsedMs: 65000, phase: "background" }]);
  work.resolve(result("完成"));
  await service.drain();
  assert.ok(phases.some((phase) => phase.includes("handoff")));
  assert.deepEqual(phases.at(-1), []);
  await service.run({ id: "quick", name: "read", to, execute: async () => result("读完") });
  assert.deepEqual(service.watching(), []);
  service.shutdown();
});
