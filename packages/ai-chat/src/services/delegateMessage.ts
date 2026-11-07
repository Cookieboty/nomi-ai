/**
 * 委派结果写进来源对话的那条消息（AiChatContext 订阅 delegate.completed）。
 * followUp：委派结束后用户在子任务里接着对话 / 沙箱授权后续跑的一轮，同样回到来源对话。
 */
import { t } from '@nomi-ai/ui';

import type { ChatMessage } from '../types/chat';
import { ENDPOINT_NAME } from '../utils/endpointBadge';

import type { DelegateResult } from './delegateClient';

/** 去掉交给模型时加的 <cli-output> 边界，只留编程助手原话（与 DelegateCard.plainSummary 一致） */
export function plainSummary(s: string): string {
  const m = /^<cli-output>\n[^\n]*\n([\s\S]*)\n<\/cli-output>$/.exec(s.trim());
  return (m ? m[1]! : s).trim();
}

function reportBody(r: DelegateResult, name: string): string {
  if (!r.report) {
    return t(
      r.followUp
        ? 'ui.session-workspace.subagent-followup-done'
        : 'ui.session-workspace.completed-the-handoff-with-body',
      name,
      plainSummary(r.summary) || t('ui.session-workspace.no-report'),
    );
  }
  return [
    r.followUp
      ? t('ui.session-workspace.subagent-followup-done', name, plainSummary(r.report.done))
      : t('ui.session-workspace.completed-the-handoff', name),
    r.followUp ? '' : plainSummary(r.report.done),
    r.report.unfinished
      ? t('ui.session-workspace.not-finished-detail', plainSummary(r.report.unfinished))
      : '',
    r.report.needsUser
      ? t('ui.session-workspace.needs-your-decision-detail', plainSummary(r.report.needsUser))
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** 委派结果 → 来源对话里的一条助手消息（id 形如 delegate-<taskId>-<durationMs>，后续轮次带 -f<时间>） */
export function delegateResultMessage(r: DelegateResult, now = Date.now()): ChatMessage {
  const name = t(ENDPOINT_NAME[r.cli] ?? r.cli);
  let body: string;
  if (r.status === 'cancelled') {
    body =
      r.cancelledBy === 'nomi'
        ? t('ui.session-workspace.s-handoff-was-stopped-with-nomi-s-turn', name)
        : t('ui.session-workspace.s-handoff-was-stopped', name);
  } else if (r.status === 'error') {
    body = r.followUp
      ? t('ui.session-workspace.subagent-followup-failed', name, r.error ?? '')
      : t('ui.session-workspace.s-handoff-failed', name, r.error ?? '');
  } else {
    body = reportBody(r, name);
  }
  return {
    id: r.followUp ? `delegate-${r.taskId}-f${now}` : `delegate-${r.taskId}-${r.durationMs}`,
    role: 'assistant',
    content: body,
    timestamp: now,
    origin: 'background',
  };
}
