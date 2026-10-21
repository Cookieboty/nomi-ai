/**
 * Codex `app-server`（stdio JSON-RPC，0.163.0 实测；协议由 `codex app-server generate-ts` 导出）的映射：
 * 权限模式 → 每轮的沙箱 / 审批参数；线程条目（camelCase）→ `exec --json` 的条目（snake_case），
 * 交给已有的 parseCodexLine，工具名与展示和每轮一个进程时完全一致；审批请求摘要；整轮用量。
 */
import type { HarnessPermissionMode } from '../types';

type Json = Record<string, unknown>;

/**
 * turn/start 的权限参数（「这一轮及之后」生效，不用重启进程）。与 permissionLaunch('codex') 同一张表：
 * 计划 = 只读；自动改文件 = 工作区可写（可选联网）；自动 = 再加自动审核员；完全放开 = 不设沙箱。
 * 逐项确认：审批策略 untrusted，审批请求走 Nomi 的权限卡片。其余档位不弹审批（与 exec 一致）。
 */
export function codexTurnPolicy(
  mode: HarnessPermissionMode,
  opts: { network: boolean },
): { sandboxPolicy: Json; approvalPolicy: string; approvalsReviewer: string } {
  const workspace = {
    type: 'workspaceWrite',
    writableRoots: [],
    networkAccess: opts.network,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
  switch (mode) {
    case 'plan':
      return {
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
      };
    case 'manual':
      return { sandboxPolicy: workspace, approvalPolicy: 'untrusted', approvalsReviewer: 'user' };
    case 'auto':
      return {
        sandboxPolicy: workspace,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review',
      };
    case 'bypass':
      return {
        sandboxPolicy: { type: 'dangerFullAccess' },
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
      };
    default:
      return { sandboxPolicy: workspace, approvalPolicy: 'never', approvalsReviewer: 'user' };
  }
}

const STATUS: Record<string, string> = {
  inProgress: 'in_progress',
  completed: 'completed',
  failed: 'failed',
  declined: 'failed',
  interrupted: 'failed',
};

const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** app-server 的线程条目 → `exec --json` 的条目；不需要展示的类型返回 null */
export function codexExecItem(item: Json): Json | null {
  const id = typeof item.id === 'string' ? item.id : undefined;
  const status = typeof item.status === 'string' ? (STATUS[item.status] ?? item.status) : undefined;
  switch (item.type) {
    case 'agentMessage':
      return { type: 'agent_message', id, text: item.text };
    case 'reasoning': {
      const parts = [item.summary, item.content].flatMap((v) =>
        Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [],
      );
      return { type: 'reasoning', id, text: parts.join('\n') };
    }
    case 'commandExecution':
      return {
        type: 'command_execution',
        id,
        command: item.command,
        aggregated_output: item.aggregatedOutput,
        exit_code: item.exitCode,
        status,
      };
    case 'fileChange':
      return { type: 'file_change', id, changes: item.changes, status };
    case 'mcpToolCall':
      return {
        type: 'mcp_tool_call',
        id,
        server: item.server,
        tool: item.tool,
        arguments: item.arguments,
        result: item.result,
        error: item.error,
        status,
      };
    case 'collabAgentToolCall': {
      const states = (item.agentsStates ?? {}) as Record<string, Json | undefined>;
      return {
        type: 'collab_tool_call',
        id,
        tool: typeof item.tool === 'string' ? snake(item.tool) : item.tool,
        status,
        sender_thread_id: item.senderThreadId,
        receiver_thread_ids: item.receiverThreadIds,
        prompt: item.prompt,
        agents_states: Object.fromEntries(
          Object.entries(states).map(([k, v]) => [
            k,
            { status: v?.status === 'errored' ? 'failed' : v?.status, message: v?.message },
          ]),
        ),
      };
    }
    case 'webSearch':
      return { type: 'web_search', id, query: item.query };
    case 'imageGeneration':
      return {
        type: 'image_generation_call',
        id,
        result: item.result,
        ...(typeof item.savedPath === 'string' ? { output: item.savedPath } : {}),
      };
    default:
      return null;
  }
}

/** 审批请求（item/commandExecution/requestApproval、item/fileChange/requestApproval）的卡片摘要 */
export function codexApprovalSummary(method: string, params: Json): string {
  const clip = (s: string) => (s.length > 200 ? `${s.slice(0, 200)}…` : s);
  if (method === 'item/commandExecution/requestApproval') {
    const cmd = typeof params.command === 'string' ? params.command : '';
    return clip(cmd ? `bash: ${cmd}` : 'bash');
  }
  const why = typeof params.reason === 'string' ? params.reason : '';
  const root = typeof params.grantRoot === 'string' ? params.grantRoot : '';
  return clip(['apply_patch', why || root].filter(Boolean).join(': '));
}

export interface CodexTokenTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/** thread/tokenUsage/updated 的累计值（缺字段按 0） */
export function codexTokenTotals(tokenUsage: unknown): CodexTokenTotals | null {
  const total = (tokenUsage as { total?: Json } | undefined)?.total;
  if (!total || typeof total !== 'object') return null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    inputTokens: n(total.inputTokens),
    cachedInputTokens: n(total.cachedInputTokens),
    outputTokens: n(total.outputTokens),
  };
}

/** 这一轮的用量 = 结束时的线程累计 − 开始时的线程累计（与 exec 的 turn.completed.usage 同口径） */
export function codexTurnUsage(
  before: CodexTokenTotals | null,
  after: CodexTokenTotals | null,
): { inputTokens: number; outputTokens: number; cacheReadTokens: number } | undefined {
  if (!after) return undefined;
  const b = before ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  return {
    inputTokens: Math.max(0, after.inputTokens - b.inputTokens),
    outputTokens: Math.max(0, after.outputTokens - b.outputTokens),
    cacheReadTokens: Math.max(0, after.cachedInputTokens - b.cachedInputTokens),
  };
}
