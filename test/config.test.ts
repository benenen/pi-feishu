import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadConfig, readConfigFile, ConfigError } from "../extensions/feishu/config.ts";

const base = { appId: "cli_x", appSecret: "sec", dmAllowlist: ["ou_1"] };

/**
 * `assert.throws` 本身不返回被捕获的异常，所以要断言 `ConfigError.problems`
 * 的内容时，需要自己 try/catch 把异常捕获出来。
 */
function throwsConfigError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    return e as ConfigError;
  }
  throw new Error("期望抛出 ConfigError，但没有抛出");
}

test("最小可用配置带出全部默认值", () => {
  const c = loadConfig({ files: [base], env: {}, cwd: "/work/repo" });
  assert.equal(c.appId, "cli_x");
  assert.equal(c.appSecret, "sec");
  assert.equal(c.autoStart, false);
  assert.equal(c.requireMention, true);
  assert.equal(c.approvalMode, "balanced");
  assert.equal(c.approvalTimeoutMs, 120_000);
  assert.equal(c.repoRoot, path.resolve("/work/repo"));
  assert.deepEqual(c.groupAllowlist, []);
});

test("环境变量优先于配置文件", () => {
  const c = loadConfig({
    files: [base],
    env: { FEISHU_APP_ID: "cli_env", FEISHU_APP_SECRET: "sec_env" },
    cwd: "/work",
  });
  assert.equal(c.appId, "cli_env");
  assert.equal(c.appSecret, "sec_env");
});

test("后面的配置文件覆盖前面的", () => {
  const c = loadConfig({
    files: [base, { autoStart: true, approvalMode: "strict" }],
    env: {},
    cwd: "/work",
  });
  assert.equal(c.autoStart, true);
  assert.equal(c.approvalMode, "strict");
});

test("缺少凭据时一次报出全部问题", () => {
  const err = throwsConfigError(() =>
    loadConfig({ files: [{ dmAllowlist: ["ou_1"] }], env: {}, cwd: "/w" }),
  );
  assert.equal(err.problems.length, 2);
  assert.ok(err.problems.some((p) => p.includes("appId")));
  assert.ok(err.problems.some((p) => p.includes("appSecret")));
});

test("allowlist 档下两个白名单都为空时拒绝启动", () => {
  const err = throwsConfigError(() =>
    loadConfig({
      files: [{ appId: "a", appSecret: "b", dmMode: "allowlist" }],
      env: {},
      cwd: "/w",
    }),
  );
  assert.ok(err.problems.some((p) => p.includes("均为空")));
});

test("非法的 approvalMode 和 approvalTimeoutMs 都被拒绝", () => {
  const err = throwsConfigError(() =>
    loadConfig({
      files: [{ ...base, approvalMode: "yolo", approvalTimeoutMs: -1 }],
      env: {},
      cwd: "/w",
    }),
  );
  assert.ok(err.problems.some((p) => p.includes("approvalMode")));
  assert.ok(err.problems.some((p) => p.includes("approvalTimeoutMs")));
});

test("repoRoot 显式配置时被解析为绝对路径", () => {
  const c = loadConfig({ files: [{ ...base, repoRoot: "/srv/proj/" }], env: {}, cwd: "/w" });
  assert.equal(c.repoRoot, path.resolve("/srv/proj"));
});

test("readConfigFile：文件不存在时安静跳过", () => {
  const r = readConfigFile("/nope/feishu.json", () => undefined);
  assert.deepEqual(r, { value: undefined });
});

test("readConfigFile：合法 JSON 被解析出来", () => {
  const r = readConfigFile("/x/feishu.json", () => '{"autoStart":true}');
  assert.deepEqual(r.value, { autoStart: true });
  assert.equal(r.problem, undefined);
});

test("readConfigFile：文件存在但语法错要报出来，而不是当成不存在", () => {
  const r = readConfigFile("/x/feishu.json", () => '{"autoStart":true,}');
  assert.equal(r.value, undefined);
  assert.ok(r.problem?.includes("/x/feishu.json"));
  assert.ok(r.problem?.includes("不是合法的 JSON"));
});

test("loadConfig：语法错的配置文件会变成一条 ConfigError 问题", () => {
  const err = throwsConfigError(() =>
    loadConfig({
      files: [{ ...base }, readConfigFile("/x/feishu.json", () => "{oops")],
      env: {},
      cwd: "/w",
    }),
  );
  assert.ok(err.problems.some((p) => p.includes("不是合法的 JSON")));
});

test("loadConfig：文件缺失不产生问题，仍用其余来源", () => {
  const c = loadConfig({
    files: [readConfigFile("/nope.json", () => undefined), { ...base }],
    env: {},
    cwd: "/w",
  });
  assert.equal(c.appId, "cli_x");
});

test("approverAllowlist 默认沿用 dmAllowlist", () => {
  const c = loadConfig({ files: [base], env: {}, cwd: "/w" });
  assert.deepEqual(c.approverAllowlist, ["ou_1"]);
});

test("approverAllowlist 可以单独指定", () => {
  const c = loadConfig({
    files: [{ ...base, approverAllowlist: ["ou_boss"] }],
    env: {},
    cwd: "/w",
  });
  assert.deepEqual(c.approverAllowlist, ["ou_boss"]);
});

test("只配 groupAllowlist 时必须显式指定审批人，否则群里谁都能批", () => {
  const err = throwsConfigError(() =>
    loadConfig({
      files: [{ appId: "a", appSecret: "b", groupAllowlist: ["oc_1"] }],
      env: {},
      cwd: "/w",
    }),
  );
  assert.ok(err.problems.some((p) => p.includes("approverAllowlist")));
});

test("只配 groupAllowlist 且指定了审批人就能通过", () => {
  const c = loadConfig({
    files: [{ appId: "a", appSecret: "b", groupAllowlist: ["oc_1"], approverAllowlist: ["ou_x"] }],
    env: {},
    cwd: "/w",
  });
  assert.deepEqual(c.approverAllowlist, ["ou_x"]);
});

test("approvalMode 接受 relaxed", () => {
  const c = loadConfig({ files: [{ ...base, approvalMode: "relaxed" }], env: {}, cwd: "/w" });
  assert.equal(c.approvalMode, "relaxed");
});

test("approvalMode 仍然拒绝乱填的值", () => {
  const e = throwsConfigError(() =>
    loadConfig({ files: [{ ...base, approvalMode: "yolo" }], env: {}, cwd: "/w" }),
  );
  assert.ok(e.problems.some((p) => p.includes("approvalMode")));
});

test("配了白名单键但没写 dmMode，自动切到 allowlist —— 老配置不会被悄悄放开", () => {
  assert.equal(loadConfig({ files: [base], env: {}, cwd: "/w" }).dmMode, "allowlist");
});

test("一个白名单键都没配时 dmMode 默认 open", () => {
  const c = loadConfig({
    files: [{ appId: "a", appSecret: "b", approverAllowlist: ["ou_me"] }],
    env: {},
    cwd: "/w",
  });
  assert.equal(c.dmMode, "open");
});

test("dmMode 接受 open / allowlist", () => {
  for (const m of ["open", "allowlist"] as const) {
    assert.equal(loadConfig({ files: [{ ...base, dmMode: m }], env: {}, cwd: "/w" }).dmMode, m);
  }
});

test("dmMode 拒绝乱填的值", () => {
  const e = throwsConfigError(() =>
    loadConfig({ files: [{ ...base, dmMode: "everyone" }], env: {}, cwd: "/w" }),
  );
  assert.ok(e.problems.some((p) => p.includes("dmMode")));
});

test("dmMode=open 时两个白名单都为空是合法的 —— 本来就不靠白名单放行", () => {
  const c = loadConfig({
    files: [
      {
        appId: "cli_x",
        appSecret: "sec",
        dmMode: "open",
        approverAllowlist: ["ou_me"],
      },
    ],
    env: {},
    cwd: "/w",
  });
  assert.equal(c.dmMode, "open");
  assert.deepEqual(c.dmAllowlist, []);
});

test("dmMode=open 也必须显式指定 approverAllowlist —— 否则谁都能批准自己", () => {
  const e = throwsConfigError(() =>
    loadConfig({
      files: [{ appId: "cli_x", appSecret: "sec", dmMode: "open" }],
      env: {},
      cwd: "/w",
    }),
  );
  assert.ok(e.problems.some((p) => p.includes("approverAllowlist")));
});

test("operatorOpenId 未配时默认取 approverAllowlist 第一个", () => {
  const c = loadConfig({
    files: [{ ...base, approverAllowlist: ["ou_a", "ou_b"] }],
    env: {},
    cwd: "/w",
  });
  assert.equal(c.operatorOpenId, "ou_a");
});

test("operatorOpenId 可以显式指定", () => {
  const c = loadConfig({
    files: [{ ...base, operatorOpenId: "ou_boss" }],
    env: {},
    cwd: "/w",
  });
  assert.equal(c.operatorOpenId, "ou_boss");
});

test("operatorOpenId 必须是字符串", () => {
  const e = throwsConfigError(() =>
    loadConfig({ files: [{ ...base, operatorOpenId: 123 }], env: {}, cwd: "/w" }),
  );
  assert.ok(e.problems.some((p) => p.includes("operatorOpenId")));
});

test("bindTarget 默认 operator", () => {
  assert.equal(loadConfig({ files: [base], env: {}, cwd: "/w" }).bindTarget, "operator");
});

test("bindTarget 接受 operator / none / 群 chat_id", () => {
  for (const t of ["operator", "none", "oc_abc123"]) {
    assert.equal(loadConfig({ files: [{ ...base, bindTarget: t }], env: {}, cwd: "/w" }).bindTarget, t);
  }
});

test("bindTarget 拒绝既不是关键字也不像 chat_id 的值", () => {
  const e = throwsConfigError(() =>
    loadConfig({ files: [{ ...base, bindTarget: "ou_someone" }], env: {}, cwd: "/w" }),
  );
  assert.ok(e.problems.some((p) => p.includes("bindTarget")), "open_id 不是会话 id，要拦");
});

test("denyPatterns / allowPatterns 默认为空数组", () => {
  const c = loadConfig({ files: [base], env: {}, cwd: "/w" });
  assert.deepEqual(c.denyPatterns, []);
  assert.deepEqual(c.allowPatterns, []);
});

test("denyPatterns / allowPatterns 读入后原样保留", () => {
  const c = loadConfig({
    files: [{ ...base, denyPatterns: ["\\bterraform\\s+apply\\b"], allowPatterns: ["\\bkill\\b"] }],
    env: {},
    cwd: "/w",
  });
  assert.deepEqual(c.denyPatterns, ["\\bterraform\\s+apply\\b"]);
  assert.deepEqual(c.allowPatterns, ["\\bkill\\b"]);
});

test("非法正则在加载配置时就报错，而不是等到判定时炸", () => {
  const e = throwsConfigError(() =>
    loadConfig({ files: [{ ...base, denyPatterns: ["(unclosed"] }], env: {}, cwd: "/w" }),
  );
  assert.ok(e.problems.some((p) => p.includes("denyPatterns")));
  assert.ok(e.problems.some((p) => p.includes("(unclosed")), "要指出是哪一条坏了");
});

test("allowPatterns 里的非法正则同样被拦下", () => {
  const e = throwsConfigError(() =>
    loadConfig({ files: [{ ...base, allowPatterns: ["a[b"] }], env: {}, cwd: "/w" }),
  );
  assert.ok(e.problems.some((p) => p.includes("allowPatterns")));
});

test("denyPatterns 必须是字符串数组", () => {
  const e = throwsConfigError(() =>
    loadConfig({ files: [{ ...base, denyPatterns: "rm" }], env: {}, cwd: "/w" }),
  );
  assert.ok(e.problems.some((p) => p.includes("denyPatterns")));
});

test("bindTarget 接受 code", () => {
  assert.equal(
    loadConfig({ files: [{ ...base, bindTarget: "code" }], env: {}, cwd: "/w" }).bindTarget,
    "code",
  );
});

test("pairingTtlMs 默认 10 分钟", () => {
  assert.equal(loadConfig({ files: [base], env: {}, cwd: "/w" }).pairingTtlMs, 600_000);
});

test("pairingTtlMs 可配，且必须是正整数", () => {
  assert.equal(
    loadConfig({ files: [{ ...base, pairingTtlMs: 60_000 }], env: {}, cwd: "/w" }).pairingTtlMs,
    60_000,
  );
  const e = throwsConfigError(() =>
    loadConfig({ files: [{ ...base, pairingTtlMs: 0 }], env: {}, cwd: "/w" }),
  );
  assert.ok(e.problems.some((p) => p.includes("pairingTtlMs")));
});

test("transport 默认 direct —— 不改变存量行为", () => {
  assert.equal(loadConfig({ files: [base], env: {}, cwd: "/w" }).transport, "direct");
});

test("transport 接受 broker", () => {
  assert.equal(
    loadConfig({ files: [{ ...base, transport: "broker" }], env: {}, cwd: "/w" }).transport,
    "broker",
  );
});

test("transport 拒绝乱填的值", () => {
  const e = throwsConfigError(() =>
    loadConfig({ files: [{ ...base, transport: "socket" }], env: {}, cwd: "/w" }),
  );
  assert.ok(e.problems.some((p) => p.includes("transport")));
});

test("brokerSocket 默认在 agentDir 下", () => {
  const c = loadConfig({ files: [base], env: {}, cwd: "/w" });
  assert.ok(c.brokerSocket.endsWith("feishu-broker.sock"), c.brokerSocket);
});

test("brokerSocket 可以显式指定", () => {
  const c = loadConfig({ files: [{ ...base, brokerSocket: "/tmp/x.sock" }], env: {}, cwd: "/w" });
  assert.equal(c.brokerSocket, "/tmp/x.sock");
});

test("autoStartBroker 默认开 —— 配了 broker 就该自动保证它在跑", () => {
  assert.equal(loadConfig({ files: [base], env: {}, cwd: "/w" }).autoStartBroker, true);
});

test("autoStartBroker 可关 —— 交给 supervisor 托管时不该由会话去拉", () => {
  const c = loadConfig({ files: [{ ...base, autoStartBroker: false }], env: {}, cwd: "/w" });
  assert.equal(c.autoStartBroker, false);
});

test("autoStartBroker 必须是布尔值", () => {
  const e = throwsConfigError(() =>
    loadConfig({ files: [{ ...base, autoStartBroker: "yes" }], env: {}, cwd: "/w" }),
  );
  assert.ok(e.problems.some((p) => p.includes("autoStartBroker")));
});

test("readReceiptEmoji 默认 EYES", () => {
  assert.equal(loadConfig({ files: [base], env: {}, cwd: "/w" }).readReceiptEmoji, "EYES");
});

test("readReceiptEmoji 可换成别的表情，也可置空关掉", () => {
  assert.equal(
    loadConfig({ files: [{ ...base, readReceiptEmoji: "OK" }], env: {}, cwd: "/w" }).readReceiptEmoji,
    "OK",
  );
  assert.equal(
    loadConfig({ files: [{ ...base, readReceiptEmoji: "" }], env: {}, cwd: "/w" }).readReceiptEmoji,
    "",
  );
});

test("readReceiptEmoji 必须是字符串", () => {
  const e = throwsConfigError(() =>
    loadConfig({ files: [{ ...base, readReceiptEmoji: 1 }], env: {}, cwd: "/w" }),
  );
  assert.ok(e.problems.some((p) => p.includes("readReceiptEmoji")));
});
