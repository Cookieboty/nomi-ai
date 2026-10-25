/**
 * 运行中的「等待态」：根据当前轮的实时数据决定底部状态行显示什么（文案 + 图标种类）。
 * 优先级：权限确认 > 上下文压缩 > 重试 / 重连 > 子代理运行 > 工具运行 > 思考 > 等待首字 > 生成回复。
 */
import { t } from '@nomi-ai/ui';

import type { ConvLive, ConvPhase } from '../types/conversation';

import { describeCall, type TimelineItem, type ToolCall } from './toolTrace';

export type StatusKind =
  | 'queued'
  | 'permission'
  | 'compact'
  | 'retry'
  | 'reconnect'
  | 'subagent'
  | 'tool'
  | 'thinking'
  | 'first-token'
  | 'writing'
  | 'working';

export interface StatusInfo {
  kind: StatusKind;
  label: string;
  /** 补充说明（工具目标 / 错误原因等） */
  detail?: string;
}

function lastRunning(items: readonly TimelineItem[]): { call?: ToolCall; subagent?: ToolCall } {
  let call: ToolCall | undefined;
  let subagent: ToolCall | undefined;
  const walk = (list: readonly TimelineItem[]) => {
    for (const it of list) {
      if (it.type === 'call' && it.call.status === 'running') call = it.call;
      else if (it.type === 'group') {
        for (const c of it.calls) if (c.status === 'running') call = c;
      } else if (it.type === 'subagent') {
        if (it.call.status === 'running') subagent = it.call;
        walk(it.children);
      }
    }
  };
  walk(items);
  return { call, subagent };
}

const attemptText = (a?: number, m?: number) => (a ? (m ? ` (${a}/${m})` : ` (${a})`) : '');

export function deriveStatus(args: {
  phase: ConvPhase;
  live?: ConvLive | null;
  items: readonly TimelineItem[];
}): StatusInfo | null {
  const { phase, live, items } = args;
  if (phase === 'queued')
    return { kind: 'queued', label: t('ui.usage-tools.queued-starts-when-other-tabs-finish') };
  if (phase !== 'running') return null;
  if (live?.permissions?.length)
    return {
      kind: 'permission',
      label:
        live.permissions.length > 1
          ? t('ui.chat-settings.waiting-for-your-confirmation', String(live.permissions.length))
          : t('ui.usage-tools.waiting-for-your-confirmation'),
    };
  const st = live?.status;
  if (st?.kind === 'compact')
    return { kind: 'compact', label: t('ui.usage-tools.compacting-context') };
  if (st?.kind === 'retry')
    return {
      kind: 'retry',
      label: t('ui.usage-tools.request-failed-retrying', attemptText(st.attempt, st.max)),
      detail: st.text,
    };
  if (st?.kind === 'reconnect')
    return {
      kind: 'reconnect',
      label: t('ui.usage-tools.connection-lost-reconnecting', attemptText(st.attempt, st.max)),
      detail: st.text,
    };
  const { call, subagent } = lastRunning(items);
  if (subagent) {
    const d = describeCall(subagent);
    // Nomi 派给编程助手的子任务（delegate_to_cli）：不是 CLI 自己的子代理
    const label =
      subagent.name === 'delegate_to_cli'
        ? t('ui.session-workspace.coding-assistant-running')
        : t('ui.usage-tools.sub-agent-running');
    return { kind: 'subagent', label, detail: d.target };
  }
  if (call) {
    const d = describeCall(call);
    return { kind: 'tool', label: `${d.verb}${d.target ? ' ' : ''}`, detail: d.target };
  }
  const last = items[items.length - 1];
  if (last?.type === 'thinking' && last.running)
    return { kind: 'thinking', label: t('ui.usage-tools.model-is-reasoning') };
  if ((!live || (live.firstEventAt === undefined && !live.text)) && !items.length)
    return { kind: 'first-token', label: t('ui.usage-tools.waiting-for-the-model') };
  if (live?.text.trim()) return { kind: 'writing', label: t('ui.usage-tools.writing-reply') };
  return { kind: 'working', label: t('ui.chat-settings.processing') };
}
