import { test } from "node:test";
import assert from "node:assert/strict";
import { BackgroundTaskStatus, renderBackgroundStatus, TASK_STATUS_KEY, type TaskSnapshot } from "../extensions/feishu/background-status.ts";

const snapshot: TaskSnapshot = {
  tools: [
    { id: "call_1", name: "bash", question: "编译项目", elapsedMs: 65000, phase: "background" },
    { id: "call_2", name: "mcp_search", elapsedMs: 2000, phase: "handoff" },
  ],
  herdr: [{ id: "watch-1", agent: "reviewer", task: "审查登录逻辑", startedAgoMs: 120000 }],
};

test("状态栏分列 background 和 watcher，完整列表带名称、任务、阶段与耗时", () => {
  const rendered = renderBackgroundStatus(snapshot);
  assert.match(rendered.status ?? "", /background 2/);
  assert.match(rendered.status ?? "", /watcher 3/);
  assert.match(rendered.status ?? "", /bash/);
  assert.match(rendered.status ?? "", /reviewer/);
  const full = rendered.lines?.join("\n") ?? "";
  for (const text of ["Background", "Watcher", "编译项目", "审查登录逻辑", "1分5秒", "2分0秒", "提交总结", "等待工具完成", "等待 agent 落地"]) assert.ok(full.includes(text), text);
  assert.doesNotMatch(full, /call_1|call_2/);
  assert.equal(renderBackgroundStatus({ tools: [], herdr: [] }).status, undefined);
  assert.equal(renderBackgroundStatus({ tools: [], herdr: [] }).lines, undefined);
});

test("状态内容清除控制字符并压成单行，完整列表不因 footer 截断而丢项目", () => {
  const tools = Array.from({ length: 8 }, (_, n) => ({ id: `call-${n}`, name: `tool_${n}`, question: "\x1b[31m带颜色\n多行\r任务\x1b[0m", elapsedMs: n * 1000, phase: "background" as const }));
  const rendered = renderBackgroundStatus({ tools, herdr: [] });
  assert.match(rendered.status ?? "", /\+5/);
  const full = rendered.lines?.join("\n") ?? "";
  assert.match(full, /tool_7/);
  assert.doesNotMatch(full, /\x1b|\r|\[31m/);
});

test("状态实例构造不启动定时器，活动任务立即显示并按秒刷新，清空时停止刷新", () => {
  let current = snapshot;
  const statuses: (string | undefined)[] = [];
  const widgets: (string[] | undefined)[] = [];
  let ticking: (() => void) | undefined;
  let schedules = 0;
  let cancelled = 0;
  const status = new BackgroundTaskStatus({
    getUI: () => ({ setStatus: (key, value) => { assert.equal(key, TASK_STATUS_KEY); statuses.push(value); }, setWidget: (key, value, options) => { assert.equal(key, TASK_STATUS_KEY); assert.equal(options?.placement, "belowEditor"); widgets.push(value); } }),
    read: () => current,
    schedule: (refresh) => { schedules++; ticking = refresh; return () => { cancelled++; ticking = undefined; }; },
  });
  assert.equal(schedules, 0, "扩展工厂声明阶段不能启动资源");
  status.refresh();
  assert.equal(schedules, 1);
  assert.match(statuses.at(-1) ?? "", /background 2/);
  current = { ...snapshot, tools: [{ ...snapshot.tools[0], elapsedMs: 66000 }] };
  ticking?.();
  assert.equal(schedules, 1, "不能重复注册定时器");
  assert.match(widgets.at(-1)?.join("\n") ?? "", /1分6秒/);
  current = { tools: [], herdr: [] };
  status.refresh();
  assert.equal(statuses.at(-1), undefined);
  assert.equal(widgets.at(-1), undefined);
  assert.equal(cancelled, 1);
  status.dispose();
  status.refresh();
  assert.equal(schedules, 1, "dispose 后不能复活");
});

test("headless 和 UI getter 失效时不启动刷新或抛错，dispose 仍取消资源", () => {
  let revoked = false;
  let schedules = 0;
  let cancelled = 0;
  const status = new BackgroundTaskStatus({
    getUI: () => { if (revoked) throw new Error("runner 已停止"); return undefined; },
    read: () => snapshot,
    schedule: () => { schedules++; return () => { cancelled++; }; },
  });
  assert.doesNotThrow(() => status.refresh());
  assert.equal(schedules, 0);
  revoked = true;
  assert.doesNotThrow(() => status.refresh());
  assert.doesNotThrow(() => status.dispose());
  assert.equal(cancelled, 0);
});

test("活跃任务停止时清除状态和完整列表；UI 失效时也取消秒级刷新", () => {
  for (const revoke of [false, true]) {
    let revoked = false;
    let cancelled = 0;
    const calls: unknown[] = [];
    const status = new BackgroundTaskStatus({
      read: () => snapshot,
      getUI: () => { if (revoked) throw new Error("UI 已失效"); return { setStatus: (_key, value) => calls.push(value), setWidget: (_key, value) => calls.push(value) }; },
      schedule: () => () => { cancelled++; },
    });
    status.refresh();
    revoked = revoke;
    assert.doesNotThrow(() => status.dispose());
    assert.equal(cancelled, 1);
    if (!revoke) assert.deepEqual(calls.slice(-2), [undefined, undefined]);
    status.refresh();
    assert.equal(cancelled, 1);
  }
});
