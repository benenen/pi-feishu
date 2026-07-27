export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m${total % 60}s`;
}

export function formatTokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}

/**
 * 压平换行、折叠空白、超长截断。
 * 按码点而非 UTF-16 码元切，否则 emoji 会被劈成孤立代理项 —— 飞书是聊天
 * 场景，emoji 是必然会遇到的。
 */
function flatten(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  const points = Array.from(one);
  return points.length <= max ? one : `${points.slice(0, max - 1).join("")}…`;
}

/** 反引号会撑破 markdown 代码片段，替换成单引号 */
function codeSpan(text: string): string {
  return `\`${text.replace(/`/g, "'")}\``;
}

/**
 * 中和会撑破粗体/代码片段的字符，用于直接插进 markup 的字段。
 * 不动下划线 —— `ask_question` 这类工具名里它很常见，剥掉反而是破坏。
 */
function plain(text: string, max: number): string {
  return flatten(text, max).replace(/[*`~]/g, "");
}

export function renderUserPrompt(
  text: string,
  source: "interactive" | "feishu",
): string | null {
  // 飞书发起的消息用户自己看得见，不必回显
  if (source !== "interactive") return null;
  return `> 💻 终端：${flatten(text, 200)}\n\n`;
}

export function renderToolStart(toolName: string, input: Record<string, unknown>): string {
  let detail = "";
  if (toolName === "bash" && typeof input.command === "string") {
    detail = flatten(input.command, 120);
  } else if (typeof input.path === "string") {
    detail = flatten(input.path, 120);
  }
  const name = plain(toolName, 40);
  return detail === ""
    ? `\n⚙️ **${name}**\n`
    : `\n⚙️ **${name}** ${codeSpan(detail)}\n`;
}

export function renderToolEnd(isError: boolean, elapsedMs: number): string {
  return isError
    ? `   ✗ 失败（${formatDuration(elapsedMs)}）\n`
    : `   ✓ ${formatDuration(elapsedMs)}\n`;
}

export function renderTurnEnd(elapsedMs: number, tokens: number): string {
  return `\n\n---\n⏱ ${formatDuration(elapsedMs)} · ${formatTokens(tokens)} tok`;
}

export function renderBlocked(toolName: string, reason: string): string {
  // reason 最终可能来自人工输入的拒绝理由，必须中和后再插进 markup
  return `\n🚫 已拦截 **${plain(toolName, 40)}** —— ${plain(reason, 200)}\n`;
}

export function renderNotice(text: string): string {
  return `\nℹ️ ${plain(text, 200)}\n`;
}
