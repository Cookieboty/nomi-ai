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
  if (phase === 'queued') return { kind: 'queued', label: t('排队等待：其它标签完成后开始') };
  if (phase !== 'running') return null;
  if (live?.permission) return { kind: 'permission', label: t('等待你的确认') };
  const st = live?.status;
  if (st?.kind === 'compact') return { kind: 'compact', label: t('正在压缩上下文…') };
  if (st?.kind === 'retry')
    return {
      kind: 'retry',
      label: t('请求失败，正在重试{0}', attemptText(st.attempt, st.max)),
      detail: st.text,
    };
  if (st?.kind === 'reconnect')
    return {
      kind: 'reconnect',
      label: t('连接中断，正在重新连接{0}', attemptText(st.attempt, st.max)),
      detail: st.text,
    };
  const { call, subagent } = lastRunning(items);
  if (subagent) {
    const d = describeCall(subagent);
    return { kind: 'subagent', label: t('子代理运行中'), detail: d.target };
  }
  if (call) {
    const d = describeCall(call);
    return { kind: 'tool', label: `${d.verb}${d.target ? ' ' : ''}`, detail: d.target };
  }
  const last = items[items.length - 1];
  if (last?.type === 'thinking' && last.running)
    return { kind: 'thinking', label: t('模型正在推理…') };
  if ((!live || (live.firstEventAt === undefined && !live.text)) && !items.length)
    return { kind: 'first-token', label: t('等待模型响应…') };
  if (live?.text.trim()) return { kind: 'writing', label: t('正在生成回复') };
  return { kind: 'working', label: t('正在处理…') };
}
