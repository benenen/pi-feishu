/**
 * 表情回应的错误判定。
 *
 * 表情 key 填错时飞书返回 231001，而 SDK 会把整个 axios 请求/响应对象打进日志 ——
 * 每条入站消息刷一次，界面很快就没法看了。所以要认出「key 不对」这一类错误，
 * 让调用方**停止重试**：key 不对是配置问题，重试一万次也不会好。
 *
 * 只认这一类，别的错误（网络抖动、限流）不能被误判 —— 那会把重试永久关掉。
 */
const INVALID_EMOJI_CODE = 231001;
const INVALID_EMOJI_TEXT = "reaction type is invalid";

export function isInvalidEmojiError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  if (typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (code === INVALID_EMOJI_CODE) return true;
  }
  // SDK 抛的是包了一层的对象，结构化字段够不着时退回文本匹配
  let text: string;
  try {
    text = err instanceof Error ? err.message : JSON.stringify(err);
  } catch {
    text = String(err);
  }
  if (typeof err === "string") text = err;
  return text.includes(String(INVALID_EMOJI_CODE)) || text.includes(INVALID_EMOJI_TEXT);
}
