import type { ApprovalRequest, Decision } from "./approval.ts";

export const APPROVAL_KIND = "pi-feishu-approval";

/** 飞书对单个卡片元素有大小限制，命令正文必须截断 */
const MAX_DETAIL_CHARS = 800;

function detailOf(req: ApprovalRequest): string {
  if (typeof req.input.command === "string") return req.input.command;
  if (typeof req.input.path === "string") return req.input.path;
  return JSON.stringify(req.input);
}

export function buildApprovalCard(id: string, req: ApprovalRequest): object {
  const detail = detailOf(req).slice(0, MAX_DETAIL_CHARS);
  return {
    config: { wide_screen_mode: true },
    header: {
      template: "orange",
      title: { tag: "plain_text", content: `⚠️ 需要审批：${req.toolName}` },
    },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: `\`\`\`\n${detail}\n\`\`\`` } },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "允许" },
            type: "primary",
            value: { kind: APPROVAL_KIND, id, allow: true },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "拒绝" },
            type: "danger",
            value: { kind: APPROVAL_KIND, id, allow: false },
          },
        ],
      },
    ],
  };
}

export function buildSettledCard(status: string): object {
  return {
    config: { wide_screen_mode: true },
    elements: [{ tag: "div", text: { tag: "lark_md", content: `**${status}**` } }],
  };
}

export function parseApprovalAction(
  value: unknown,
): { id: string; allow: boolean } | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const v = value as { kind?: unknown; id?: unknown; allow?: unknown };
  if (v.kind !== APPROVAL_KIND || typeof v.id !== "string") return undefined;
  // 只有显式 true 才算批准
  return { id: v.id, allow: v.allow === true };
}

/** 显式收件方优先；都没有时返回 undefined，调用方应放弃发送 */
export function resolveTarget(
  bound: string | undefined,
  explicit?: string,
): string | undefined {
  return explicit ?? bound;
}

interface PendingEntry {
  resolve: (d: Decision) => void;
  messageId: string;
}

/** 未决审批登记表。每个 id 至多兑现一次。 */
export class ApprovalRegistry {
  #pending = new Map<string, PendingEntry>();

  get size(): number {
    return this.#pending.size;
  }

  register(id: string, messageId: string): Promise<Decision> {
    return new Promise<Decision>((resolve) => {
      this.#pending.set(id, { resolve, messageId });
    });
  }

  /** 兑现并移除；返回该审批的卡片 messageId，未知 id 返回 undefined */
  settle(id: string, decision: Decision): string | undefined {
    const entry = this.#pending.get(id);
    if (!entry) return undefined;
    this.#pending.delete(id);
    entry.resolve(decision);
    return entry.messageId;
  }

  cancel(id: string, decision: Decision): string | undefined {
    return this.settle(id, decision);
  }

  cancelAll(decision: Decision): void {
    for (const id of [...this.#pending.keys()]) this.settle(id, decision);
  }
}
