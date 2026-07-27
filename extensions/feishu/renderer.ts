export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m${total % 60}s`;
}

export function formatTokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}

/** 压平换行、折叠空白、超长截断 */
function flatten(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

/** 反引号会撑破 markdown 代码片段，替换成单引号 */
function codeSpan(text: string): string {
  return `\`${text.replace(/`/g, "'")}\``;
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
  return detail === ""
    ? `\n⚙️ **${toolName}**\n`
    : `\n⚙️ **${toolName}** ${codeSpan(detail)}\n`;
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
  return `\n🚫 已拦截 **${toolName}** —— ${reason}\n`;
}

export function renderNotice(text: string): string {
  return `\nℹ️ ${text}\n`;
}
