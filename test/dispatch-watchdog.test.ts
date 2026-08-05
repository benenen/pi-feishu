import { test } from "node:test";
import assert from "node:assert/strict";
import { DispatchWatchdog } from "../extensions/feishu/dispatch-watchdog.ts";

function fixture() {
  let seq = 0;
  const callbacks = new Map<number, () => void>();
  const cleared: number[] = [];
  const watchdog = new DispatchWatchdog(120_000, {
    set(fn, ms) {
      assert.equal(ms, 120_000);
      const id = (seq += 1);
      callbacks.set(id, fn);
      return id;
    },
    clear(handle) {
      const id = handle as number;
      cleared.push(id);
      callbacks.delete(id);
    },
  });
  return { watchdog, callbacks, cleared };
}

test("watchdog 到期时执行对应投递的止损回调", () => {
  const { watchdog, callbacks } = fixture();
  const expired: string[] = [];
  watchdog.arm("om_1", () => expired.push("om_1"));

  callbacks.get(1)?.();

  assert.deepEqual(expired, ["om_1"]);
  assert.equal(watchdog.size, 0);
});

test("before_agent_start 清掉 watchdog 后，迟到定时器不能再误清合法投递", () => {
  const { watchdog, callbacks, cleared } = fixture();
  const expired: string[] = [];
  watchdog.arm("om_1", () => expired.push("om_1"));
  const staleCallback = callbacks.get(1)!;

  watchdog.clear("om_1");
  staleCallback();

  assert.deepEqual(cleared, [1]);
  assert.deepEqual(expired, [], "即使事件循环里已有迟到 callback，也必须以当前登记为准");
});

test("停止桥接会清掉全部未决 watchdog", () => {
  const { watchdog, cleared } = fixture();
  watchdog.arm("om_1", () => {});
  watchdog.arm("om_2", () => {});

  watchdog.clearAll();

  assert.deepEqual(cleared, [1, 2]);
  assert.equal(watchdog.size, 0);
});
