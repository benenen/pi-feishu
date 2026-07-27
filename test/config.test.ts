import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadConfig, ConfigError } from "../extensions/feishu/config.ts";

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

test("两个白名单都为空时拒绝启动", () => {
  const err = throwsConfigError(() =>
    loadConfig({ files: [{ appId: "a", appSecret: "b" }], env: {}, cwd: "/w" }),
  );
  assert.ok(err.problems.some((p) => p.includes("不能同时为空")));
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
