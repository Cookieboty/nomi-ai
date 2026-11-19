/**
 * 后台委派终态的短暂轻提示（Toast）：代替往会话流底部写入无意义的「委派任务已停止」等累加消息，
 * 短时间连续到达的同类通知自动合并计数并在数秒后自动消失。
 */
import { t } from '@nomi-ai/ui';

export const DELEGATE_NOTICE_EVENT = 'nomi:delegate-notice';
export const DELEGATE_NOTICE_DURATION_MS = 3200;

export type DelegateNoticeKind = 'stopped' | 'done' | 'failed';

export interface DelegateNoticeDetail {
  kind: DelegateNoticeKind;
  agentName: string;
  cancelledBy?: 'user' | 'nomi';
}

/** 根据通知类型与累计条数生成单条 / 聚合轻提示文案 */
export function formatDelegateNotice(detail: DelegateNoticeDetail, count = 1): string {
  if (count > 1) {
    switch (detail.kind) {
      case 'stopped':
        return t('ui.session-workspace.delegate-notice-stopped-many', String(count));
      case 'done':
        return t('ui.session-workspace.delegate-notice-done-many', String(count));
      case 'failed':
        return t('ui.session-workspace.delegate-notice-failed-many', String(count));
    }
  }
  switch (detail.kind) {
    case 'stopped':
      return detail.cancelledBy === 'nomi'
        ? t('ui.session-workspace.delegate-notice-stopped-with-turn', detail.agentName)
        : t('ui.session-workspace.delegate-notice-stopped', detail.agentName);
    case 'done':
      return t('ui.session-workspace.delegate-notice-done', detail.agentName);
    case 'failed':
      return t('ui.session-workspace.delegate-notice-failed', detail.agentName);
  }
}

/** 派发一条委派状态轻提示事件（无 DOM 环境时静默忽略） */
export function emitDelegateNotice(detail: DelegateNoticeDetail): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent<DelegateNoticeDetail>(DELEGATE_NOTICE_EVENT, { detail }));
}
