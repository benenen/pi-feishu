import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger, createSdkLogger, type LogSink } from "../extensions/feishu/log.ts";

interface Notified {
  message: string;
  level: string | undefined;
}

/** 记录 notify 调用的假 UI，hasUI 可控 */
function fakeSink(hasUI: boolean, notified: Notified[]): LogSink {
  return {
    get hasUI() {
      return hasUI;
    },
    ui: {
      notify(message, level) {
        notified.push({ message, level });
      },
    },
  };
}

test("有 UI 时日志走 notify，不写 stderr", () => {
  const notified: Notified[] = [];
  const stderr: string[] = [];
  const log = createLogger(() => fakeSink(true, notified), (line) => stderr.push(line));

  log("飞书连接已恢复");

  assert.deepEqual(notified, [{ message: "[pi-feishu] 飞书连接已恢复", level: "info" }]);
  assert.deepEqual(stderr, []);
});

test("notify 的级别可以指定", () => {
  const notified: Notified[] = [];
  const log = createLogger(() => fakeSink(true, notified), () => {});

  log("飞书拒收消息：sender_not_allowed", "warning");

  assert.equal(notified[0]?.level, "warning");
});

test("没有 UI（headless）时回退到 stderr", () => {
  const notified: Notified[] = [];
  const stderr: string[] = [];
  const log = createLogger(() => fakeSink(false, notified), (line) => stderr.push(line));

  log("飞书错误：1 boom");

  assert.deepEqual(stderr, ["[pi-feishu] 飞书错误：1 boom"]);
  assert.deepEqual(notified, []);
});

test("尚未拿到 ctx 时回退到 stderr", () => {
  const stderr: string[] = [];
  const log = createLogger(() => undefined, (line) => stderr.push(line));

  log("启动中");

  assert.deepEqual(stderr, ["[pi-feishu] 启动中"]);
});

// ctx 的属性是惰性 getter，runner 停用后访问会 assertActive() 抛错。
// 日志是从 catch 块和飞书 SDK 回调里调的，绝不能让它把异常再抛出去。
test("runner 已停用（读 hasUI 抛错）时不抛异常，回退到 stderr", () => {
  const stderr: string[] = [];
  const dead: LogSink = {
    get hasUI(): boolean {
      throw new Error("Extension runner is no longer active");
    },
    ui: {
      notify() {
        throw new Error("不应该走到这里");
      },
    },
  };
  const log = createLogger(() => dead, (line) => stderr.push(line));

  assert.doesNotThrow(() => log("会话切换时断开飞书超时"));
  assert.deepEqual(stderr, ["[pi-feishu] 会话切换时断开飞书超时"]);
});

test("notify 自身抛错时消息不丢，落到 stderr", () => {
  const stderr: string[] = [];
  const racing: LogSink = {
    hasUI: true,
    ui: {
      notify() {
        throw new Error("TUI 正在拆除");
      },
    },
  };
  const log = createLogger(() => racing, (line) => stderr.push(line));

  assert.doesNotThrow(() => log("飞书连接断开，重连中"));
  assert.deepEqual(stderr, ["[pi-feishu] 飞书连接断开，重连中"]);
});

// 飞书 SDK 的 defaultLogger 直接写 console.log/warn/info/debug，
// 而 LarkChannel 会把它传给 WSClient / rawClient / OutboundSender ——
// 不接管的话，连接和重连的日志照样往 TUI 里喷。
interface Logged {
  msg: string;
  level: string | undefined;
}

function recordingLog(out: Logged[]) {
  return (msg: string, level?: string) => out.push({ msg, level });
}

test("SDK 的 error 映射成 error 级", () => {
  const out: Logged[] = [];
  createSdkLogger(recordingLog(out)).error("appId is needed");
  assert.deepEqual(out, [{ msg: "飞书 SDK：appId is needed", level: "error" }]);
});

test("SDK 的 warn 映射成 warning 级", () => {
  const out: Logged[] = [];
  createSdkLogger(recordingLog(out)).warn("ws reconnecting");
  assert.equal(out[0]?.level, "warning");
});

test("SDK 的 info / debug / trace 都降到 info 级", () => {
  const out: Logged[] = [];
  const l = createSdkLogger(recordingLog(out));
  l.info("connected");
  l.debug("frame");
  l.trace("raw");
  assert.deepEqual(
    out.map((e) => e.level),
    ["info", "info", "info"],
  );
});

test("多个参数拼成一条消息", () => {
  const out: Logged[] = [];
  createSdkLogger(recordingLog(out)).error("request failed", 500);
  assert.equal(out[0]?.msg, "飞书 SDK：request failed 500");
});

test("非字符串参数不会让日志抛错", () => {
  const out: Logged[] = [];
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const l = createSdkLogger(recordingLog(out));

  assert.doesNotThrow(() => l.error(new Error("boom"), cyclic, undefined));
  assert.equal(out.length, 1);
  assert.ok(out[0]?.msg.includes("boom"));
});

// LoggerProxy 的实现是 warn(...msg) → this.logger.warn(msg)：
// 不管 SDK 内部传了几个参数，到适配器手里永远是一个数组。
test("SDK 递进来的参数数组被摊平，不留方括号", () => {
  const out: Logged[] = [];
  createSdkLogger(recordingLog(out)).warn(["ws closed", 1006]);
  assert.equal(out[0]?.msg, "飞书 SDK：ws closed 1006");
});

// LarkChannel 只注册 6 类事件，应用在开放平台多订阅一个（比如已读回执
// im.message.message_read_v1），每来一条 SDK 就 warn 一次。运行时无从处置，纯噪音。
test("未注册事件的 no … handle 提示被丢弃", () => {
  const out: Logged[] = [];
  const l = createSdkLogger(recordingLog(out));
  l.warn(["no im.message.message_read_v1 handle"]);
  l.warn(["no im.chat.member.user.added_v1 handle"]);
  assert.deepEqual(out, []);
});

test("其他 warn 不会被这条过滤规则误伤", () => {
  const out: Logged[] = [];
  createSdkLogger(recordingLog(out)).warn(["verification failed event"]);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.msg, "飞书 SDK：verification failed event");
});
