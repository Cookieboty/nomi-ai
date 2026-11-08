/**
 * 委派结果写进来源对话的那条消息（AiChatContext 订阅 delegate.completed）。
 * followUp：委派结束后用户在子任务里接着对话 / 沙箱授权后续跑的一轮，同样回到来源对话。
 * 子任务产出的东西（生成的图片、改动的文件）都写进这条消息：用户看得到，Nomi 下一轮也从历史里读得到。
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

/** 生成的图片：只认素材库地址（与 Markdown 图片白名单一致），对话里直接显示，Nomi 下一轮能引用 */
const IMAGE_URL = /^chat-asset:\/\/images\/[A-Za-z0-9._-]+$/;

function imagesBlock(r: DelegateResult): string {
  const urls = [...new Set((r.images ?? []).filter((u) => IMAGE_URL.test(u)))];
  return urls.map((u, i) => `![${i + 1}](${u})`).join('\n');
}

const hasProducts = (r: DelegateResult) =>
  !!(r.images?.length || r.changedFiles?.length || r.report?.changedFiles?.length);

function reportBody(r: DelegateResult, name: string): string {
  // 只交出了图片 / 文件、没写汇报：不再显示「没有汇报」，东西列在后面
  if (!r.report && !plainSummary(r.summary) && hasProducts(r)) {
    return t('ui.session-workspace.completed-the-handoff', name);
  }
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

/** 列在消息里的改动文件最多几个（其余只报数量；完整列表在委派卡片里） */
export const CHANGED_FILES_SHOWN = 20;

/**
 * 改动的文件：对话里看得到，Nomi 下一轮从历史里也读得到（后台委派的结果不经工具输出回到模型）。
 * 优先用编程助手汇报里的（已按 git 核对），没有汇报时用内核核对出的列表（持续任务的结果只有这个）
 */
function changedFilesBlock(r: DelegateResult): string {
  const files = (r.report?.changedFiles?.length ? r.report.changedFiles : r.changedFiles) ?? [];
  const list = [...new Set(files.filter(Boolean))];
  if (!list.length) return '';
  const lines = list.slice(0, CHANGED_FILES_SHOWN).map((f) => `- \`${f}\``);
  if (list.length > CHANGED_FILES_SHOWN) {
    lines.push(
      t('ui.session-workspace.handoff-changed-files-more', list.length - CHANGED_FILES_SHOWN),
    );
  }
  return t('ui.session-workspace.handoff-changed-files', list.length, lines.join('\n'));
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
  // 子任务产出的东西（生成的图片、改动的文件）都带回对话：出错 / 被停下时已经产出的也列出来，用户和 Nomi 都该知道
  for (const block of [imagesBlock(r), changedFilesBlock(r)]) {
    if (block) body = `${body}\n\n${block}`;
  }
  return {
    id: r.followUp ? `delegate-${r.taskId}-f${now}` : `delegate-${r.taskId}-${r.durationMs}`,
    role: 'assistant',
    content: body,
    timestamp: now,
    origin: 'background',
  };
}
