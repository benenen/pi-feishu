import { test } from "node:test";
import assert from "node:assert/strict";
import type { HerdrCli } from "../extensions/herdr/cli.ts";
import { err, ok, type Result } from "../extensions/herdr/types.ts";
import {
  extractPiAnswer,
  harvestResult,
  tailTrim,
} from "../extensions/herdr/harvest.ts";

const message = (role: string, content: unknown) =>
  JSON.stringify({ type: "message", id: "m", message: { role, content } });

test("extractPiAnswer 取最后一条有正文的 assistant 回复", () => {
  const jsonl = [
    JSON.stringify({ type: "session", id: "s" }),
    message("user", [{ type: "text", text: "问题" }]),
    message("assistant", [{ type: "text", text: "先看一眼" }]),
    message("assistant", [{ type: "toolCall", name: "read" }]),
    message("assistant", [{ type: "text", text: "最终答案\n第二行" }]),
  ].join("\n");
  assert.equal(extractPiAnswer(jsonl), "最终答案\n第二行");
});

test("extractPiAnswer 支持 content 是裸字符串，跳过纯工具消息", () => {
  const jsonl = [
    message("assistant", "字符串正文"),
    message("assistant", [{ type: "toolCall", name: "bash" }]),
  ].join("\n");
  assert.equal(extractPiAnswer(jsonl), "字符串正文");
});

test("extractPiAnswer 对半行/脏行/空内容返回 undefined", () => {
  assert.equal(extractPiAnswer(""), undefined);
  assert.equal(extractPiAnswer('{"type":"message"'), undefined);
  assert.equal(extractPiAnswer(message("assistant", [{ type: "text", text: "   " }])), undefined);
  assert.equal(extractPiAnswer(message("user", "x")), undefined);
});

test("tailTrim 保留结尾并标注省略量", () => {
  assert.equal(tailTrim("短", 10), "短");
  const long = "a".repeat(50);
  const out = tailTrim(long, 10);
  assert.match(out, /前面省略 40 字/);
  assert.ok(out.endsWith("a".repeat(10)));
});

function fakeCli(handler: (args: string[]) => Result<unknown>) {
  const cli: HerdrCli = {
    bin: "herdr",
    async run<T>(args: string[]): Promise<Result<T>> {
      return handler(args) as Result<T>;
    },
  };
  return cli;
}

test("harvestResult：pi 有会话文件时抽干净回复，不动面板", async () => {
  let paneReads = 0;
  const cli = fakeCli(() => {
    paneReads += 1;
    return ok("面板输出");
  });
  const r = await harvestResult(
    cli,
    "p",
    { status: "idle", focused: false, sessionPath: "/tmp/s.jsonl" },
    { readTail: async () => message("assistant", "干净答案") },
  );
  assert.deepEqual(r.ok ? r.data : undefined, { text: "干净答案", source: "session" });
  assert.equal(paneReads, 0);
});

test("harvestResult：会话文件读不到时退回面板输出", async () => {
  const cli = fakeCli(() => ok("面板最后几行\n"));
  const r = await harvestResult(
    cli,
    "p",
    { status: "idle", focused: false, sessionPath: "/tmp/nope.jsonl" },
    {
      readTail: async () => {
        throw new Error("ENOENT");
      },
    },
  );
  assert.deepEqual(r.ok ? r.data : undefined, { text: "面板最后几行", source: "pane" });
});

test("harvestResult：没有会话文件（claude/codex）直接用面板输出", async () => {
  const cli = fakeCli(() => ok("claude 的答复\n\n页脚\n"));
  const r = await harvestResult(cli, "c", { status: "idle", focused: false });
  assert.deepEqual(r.ok ? r.data : undefined, { text: "claude 的答复\n\n页脚", source: "pane" });
});

test("harvestResult：agent 已消失时如实报错", async () => {
  const cli = fakeCli(() => err("NOT_FOUND", "agent 没了"));
  const r = await harvestResult(cli, "c", undefined);
  assert.equal(r.ok ? "" : r.error.code, "NOT_FOUND");
});
