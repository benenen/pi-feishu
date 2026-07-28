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
