import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, symlink, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import os from "node:os";
import { patchSource } from "../scripts/patch-pi-background.ts";
import { BackgroundTools, installBackgroundToolHook } from "../extensions/feishu/background-tools.ts";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import type { AgentToolCall, RunToolCallOptions } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

const require = createRequire(import.meta.url);

/** 在真 pi 核心的副本上跑，CI 无需修改 node_modules 或全局安装。 */
async function coreFixture(patched: boolean) {
  const coreDir = path.join(path.dirname(require.resolve('@earendil-works/pi-agent-core/package.json')), 'dist');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-background-core-'));
  await symlink(path.resolve('node_modules'), path.join(dir, 'node_modules'), 'dir');
  const corePath = path.join(coreDir, 'agent-loop.js');
  const original = await readFile(corePath + '.pi-feishu-background.bak', 'utf8').catch(() => readFile(corePath, 'utf8'));
  const source = (patched ? patchSource(original) : original).replace('"./stream-fn.js"', JSON.stringify(pathToFileURL(path.join(coreDir, 'stream-fn.js')).href));
  const file = path.join(dir, 'agent-loop.mjs');
  await writeFile(file, source);
  const module = await import(pathToFileURL(file).href) as {
    runToolCall: (call: AgentToolCall, options: RunToolCallOptions) => ReturnType<typeof import('@earendil-works/pi-agent-core')['runToolCall']>;
  };
  return { run: module.runToolCall, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const message: AssistantMessage = {
  role: 'assistant', content: [], api: 'openai-completions', provider: 'test', model: 'test', stopReason: 'toolUse', timestamp: 0,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};

test("真 pi 核心：慢 MCP 工具先交给 watcher，后续工具继续；审批拒绝不启动任务", async () => {
  const fixture = await coreFixture(true);
  const sent: string[] = [];
  const service = new BackgroundTools({ waitMs: 5, onComplete: async (completion) => { sent.push(completion.body); }, log: () => {} });
  const removeHook = installBackgroundToolHook(service, () => ({ chatId: '原对话' }));
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let executed = 0;
  const tool = {
    name: 'mcp_slow', label: '慢 MCP 工具', description: '慢 MCP 工具', parameters: { type: 'object', properties: {} } as never,
    async execute() { executed += 1; await pending; return { content: [{ type: 'text' as const, text: 'PONG' }], details: {} }; },
  };
  const options: RunToolCallOptions = { tools: [tool], assistantMessage: message, context: { messages: [], tools: [tool] } };
  try {
    const denied = await fixture.run({ type: 'toolCall', id: 'deny', name: tool.name, arguments: {} }, { ...options, beforeToolCall: async () => ({ block: true, reason: '拒绝' }) });
    assert.equal(denied.isError, true);
    assert.equal(executed, 0, '拒绝时连后台任务都不能启动');
    const ack = await Promise.race([
      fixture.run({ type: 'toolCall', id: 'slow', name: tool.name, arguments: {} }, options),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('核心仍然阻塞主 agent')), 100)),
    ]);
    assert.equal(ack.isError, false);
    assert.equal(ack.result.details.background, true);
    assert.equal(executed, 1);
    assert.deepEqual(sent, []);
    const quick = { ...tool, name: 'mcp_quick', async execute() { return { content: [{ type: 'text' as const, text: 'NEXT_OK' }], details: {} }; } };
    const next = await fixture.run({ type: 'toolCall', id: 'next', name: quick.name, arguments: {} }, { ...options, tools: [quick] });
    assert.equal(next.result.content[0].type === 'text' && next.result.content[0].text, 'NEXT_OK');
    assert.equal(service.count, 1, '快工具已完成时，原慢工具仍在后台');
    release();
    await service.drain();
    assert.match(sent[0], /PONG/);
  } finally {
    release();
    removeHook();
    await service.drain();
    await fixture.cleanup();
  }
});

test("真 pi 核心与原生 bash：超出等待期限后继续执行，完成才回传正文", async () => {
  const fixture = await coreFixture(true);
  const sent: string[] = [];
  const service = new BackgroundTools({ waitMs: 5, onComplete: async (completion) => { sent.push(completion.body); }, log: () => {} });
  const removeHook = installBackgroundToolHook(service, () => ({ chatId: '原对话' }));
  const bash = createBashTool(process.cwd());
  try {
    const ack = await fixture.run({ type: 'toolCall', id: 'bash-slow', name: 'bash', arguments: { command: "node -e 'setTimeout(()=>console.log(\"PONG\"),150)'" } },
      { tools: [bash], assistantMessage: message, context: { messages: [], tools: [bash] } });
    assert.equal(ack.result.details.background, true);
    assert.deepEqual(sent, []);
    await service.drain();
    assert.match(sent[0], /PONG/);
  } finally {
    removeHook();
    await service.drain();
    await fixture.cleanup();
  }
});
