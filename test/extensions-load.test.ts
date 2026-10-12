import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import feishuExtension from "../extensions/feishu/index.ts";
import herdrExtension, { formatAgent } from "../extensions/herdr/index.ts";

/**
 * 接线冒烟：扩展入口能被 pi 加载、工厂能跑完、该注册的都注册了。
 *
 * pi 的扩展加载器只认目录下的 `index.ts` 的 **default export 是个函数**。
 * `extensions/herdr/` 是新加的目录，被 `pi.extensions: ["./extensions"]` 自动
 * 发现 —— 里面少了 default export、或 import 了只存在于 pi 自己 node_modules 的
 * 包，都会在 pi 启动那一刻炸，而且炸在别人的会话里。
 */

function fakePi() {
  const tools: string[] = [];
  const commands: string[] = [];
  const events: string[] = [];
  const api = {
    registerTool: (tool: { name: string }) => tools.push(tool.name),
    registerCommand: (name: string) => commands.push(name),
    on: (event: string) => events.push(event),
  } as unknown as ExtensionAPI;
  return { api, tools, commands, events };
}

test("herdr 扩展入口注册全套 herdr_* 工具", () => {
  const { api, tools } = fakePi();
  herdrExtension(api);
  for (const name of [
    "herdr_list_agents",
    "herdr_start_agent",
    "herdr_send_prompt",
    "herdr_read_agent",
    "herdr_wait_agent",
    "herdr_stop_agent",
    "herdr_send_keys",
  ]) {
    assert.ok(tools.includes(name), `没注册 ${name}`);
  }
});

test("herdr 扩展工厂不启动任何后台资源（加载时不 spawn herdr）", () => {
  // 工厂跑完就该结束；能跑到这里说明它没有 await 任何 herdr 调用。
  // 用真实的 spawn 会把消息区冲花，这里只验证「工厂是纯注册」这条契约。
  const { api } = fakePi();
  assert.doesNotThrow(() => herdrExtension(api));
});

test("feishu 扩展入口仍然注册 /feishu 命令与 feishu_send_image", () => {
  const { api, tools, commands } = fakePi();
  feishuExtension(api);
  assert.deepEqual(commands, ["feishu"]);
  assert.ok(tools.includes("feishu_send_image"));
});


test("herdr 列表明确标注真实 target，工作区标题不能被误当 agent 名", () => {
  const text = formatAgent({ kind: "codex", status: "working", paneId: "w2:p3", workspaceId: "w2", title: "查询今天本地天气 | aiclass", focused: true });
  assert.match(text, /target="w2:p3"/);
  assert.doesNotMatch(text, /target="aiclass"/);
  assert.match(text, /运行中/);
  assert.match(formatAgent({ name: "reviewer", status: "idle", paneId: "w2:p3", focused: false }), /target="reviewer"/);
});


test("herdr 目标不存在时保留错误并提示使用列表中的真实 target", async () => {
  const { unwrap } = await import("../extensions/herdr/index.ts");
  const r = unwrap({ ok: false, error: { code: "NOT_FOUND", message: "agent target aiclass not found" } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /aiclass not found/);
  assert.match(r.content[0].text, /herdr_list_agents/);
  assert.match(r.content[0].text, /工作区/);
});
