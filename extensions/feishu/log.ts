export type NotifyLevel = "info" | "warning" | "error";

/** ExtensionContext 中日志真正用得上的那一小块 */
export interface LogSink {
  hasUI: boolean;
  ui: { notify(message: string, level?: NotifyLevel): void };
}

/**
 * 网关日志必须走 pi 的 UI 通道，不能裸写 stderr —— pi 的 TUI 不接管 stderr，
 * console.error 会直接打进渲染区（光标所在的输入框那一片），把界面冲花；
 * 飞书断线重连之类的日志一多，整个会话就没法操作了。
 *
 * getSink 传的是取值函数而不是现成对象：ExtensionContext 的属性全是惰性 getter，
 * 存下引用晚点读也能拿到当时的 UI；但 runner 停用后读它会抛错，所以整段都得吞异常。
 * 没有 UI（headless）或者 runner 已停用时，没有 TUI 可冲，stderr 反而是对的去处。
 */
export type LogFn = (msg: string, level?: NotifyLevel) => void;

/** 结构上兼容飞书 SDK 的 Logger，不用把 SDK 的类型拖进这个模块 */
export interface SdkLogger {
  error: (...msg: unknown[]) => void;
  warn: (...msg: unknown[]) => void;
  info: (...msg: unknown[]) => void;
  debug: (...msg: unknown[]) => void;
  trace: (...msg: unknown[]) => void;
}

/**
 * SDK 的 EventDispatcher 对任何没注册 handler 的事件类型都 warn 一次
 * （`no ${type} handle`）。LarkChannel 只注册 6 类事件，应用在开放平台上多订阅一个
 * （比如已读回执 im.message.message_read_v1），每来一条就刷一行 —— 运行时无从处置，
 * 只能靠改开放平台的事件订阅来根治，日志里没必要重复喊。
 */
const UNHANDLED_EVENT = /^no \S+ handle$/;

/** 循环引用的对象会让 JSON.stringify 抛错，日志绝不能因为参数长得怪就炸 */
function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.message;
  try {
    return typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
  } catch {
    return String(v);
  }
}

/**
 * 把飞书 SDK 的日志接管过来。SDK 的 defaultLogger 直接写 console.log/warn/info/debug，
 * 而 LarkChannel 会把 logger 传给 WSClient / rawClient / OutboundSender —— 不接管的话，
 * 连接、重连、HTTP 错误照样绕过 pi 的 UI 打进 TUI 渲染区。
 *
 * debug / trace 也一并降级到 info：SDK 默认 level 是 info，本来就滤掉它们；
 * 真调到 debug 时也该跟其他日志走同一条路，而不是重新落回 stdout。
 */
export function createSdkLogger(log: LogFn): SdkLogger {
  const at =
    (level: NotifyLevel) =>
    (...msg: unknown[]) => {
      // LoggerProxy 的实现是 warn(...msg) → this.logger.warn(msg)：
      // 不管 SDK 内部传了几个参数，到这里永远是一个数组，不摊平就会打出方括号
      const text = msg.flat().map(stringify).join(" ");
      if (UNHANDLED_EVENT.test(text)) return;
      log(`飞书 SDK：${text}`, level);
    };
  return {
    error: at("error"),
    warn: at("warning"),
    info: at("info"),
    debug: at("info"),
    trace: at("info"),
  };
}

export function createLogger(
  getSink: () => LogSink | undefined,
  fallback: (line: string) => void = (line) => console.error(line),
): LogFn {
  return (msg, level = "info") => {
    const line = `[pi-feishu] ${msg}`;
    try {
      const sink = getSink();
      if (sink?.hasUI) {
        sink.ui.notify(line, level);
        return;
      }
    } catch {
      // 读 ctx 或 notify 本身抛错 —— 落到下面的 fallback，消息不能丢
    }
    fallback(line);
  };
}
