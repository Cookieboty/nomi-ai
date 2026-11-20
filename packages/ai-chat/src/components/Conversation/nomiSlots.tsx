/**
 * Nomi 普通对话在统一会话视图里的扩展内容：参考记忆、图片、知识库引用 / 来源、知识库标签、委派结果的改动。
 * 这些是 Nomi 独有的数据（ChatMessage.raw），视图本身只认统一的 ConvMessage。
 */
import { Disclosure, t } from '@nomi-ai/ui';
import React, { useEffect, useState } from 'react';

import type { KbSource } from '../../services/kbClient';
import { requestOpenTask, tasksApi, tasksAvailable, type Task } from '../../services/tasksClient';
import type { ChatMessage } from '../../types/chat';
import type { ConvMessage } from '../../types/conversation';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';

import { SourceList, SourcePreview } from './Citations';
import styles from './Citations.module.css';
import { CiteProvider } from './citeRefs';
import { DelegateChangesCard } from './DelegateChangesCard';
import { Markdown } from './Markdown';
import type { ConvSlots } from './Messages';
import { UserImages } from './UserImages';

const rawOf = (m: ConvMessage): ChatMessage | undefined =>
  m.raw && typeof m.raw === 'object' && 'timestamp' in m.raw && 'content' in m.raw
    ? (m.raw as ChatMessage)
    : undefined;

/** 带来源的回答：正文里的 [n] 可点击，来源列表 + 预览 */
const CitedBody: React.FC<{ message: ChatMessage }> = ({ message }) => {
  const [pick, setPick] = useState<KbSource | null>(null);
  const sources = message.sources ?? [];
  return (
    <>
      {/* 与普通回复同一个 Markdown 渲染器；[n] 由 CiteProvider 变成可点击的引用 */}
      <CiteProvider sources={sources} onPick={setPick}>
        <Markdown text={message.content} settled citations />
      </CiteProvider>
      <Disclosure
        className={styles.stepRow}
        summaryClassName={styles.stepSummary}
        defaultOpen
        summary={
          <>
            {message.kb ? t('ui.foundation.knowledge-base') : t('ui.knowledge-local.sources')} ·{' '}
            {sources.length} {t('ui.providers-schedule.sources-count-suffix')}
          </>
        }
      >
        <SourceList sources={sources} onPick={setPick} />
      </Disclosure>
      <SourcePreview source={pick} onClose={() => setPick(null)} />
    </>
  );
};

const handoffStatusDesc = (status?: Task['status']): string => {
  switch (status) {
    case 'queued':
      return t('ui.providers-schedule.task-handoff-queued');
    case 'done':
    case 'awaiting_accept':
      return t('ui.providers-schedule.task-handoff-done');
    case 'failed':
    case 'expired':
      return t('ui.providers-schedule.task-handoff-failed');
    case 'cancelled':
      return t('ui.providers-schedule.task-handoff-cancelled');
    default:
      return t('ui.providers-schedule.task-handoff-running');
  }
};

/** 对话里由「转后台」或 `/bg` 产生的任务状态摘要卡：实时跟进任务看板状态并可一键直达 */
const HandoffTaskCard: React.FC<{ taskId: string }> = ({ taskId }) => {
  const [task, setTask] = useState<Task | null>(null);

  useEffect(() => {
    if (!tasksAvailable()) return;
    let alive = true;
    const load = () => {
      void tasksApi
        .get(taskId)
        .then((next) => {
          if (alive && next?.task) setTask(next.task);
        })
        .catch(() => undefined);
    };
    load();
    const off = tasksApi.onChange(() => {
      load();
    });
    return () => {
      alive = false;
      off();
    };
  }, [taskId]);

  const status = task?.status ?? 'running';
  return (
    <div className={styles.handoffCard} data-testid="handoff-task-card" data-status={status}>
      <div className={styles.handoffCardMain}>
        <span className={styles.handoffCardTitle}>
          {t('ui.providers-schedule.task-handoff-card-title')}
        </span>
        <span className={styles.handoffCardDesc}>{handoffStatusDesc(task?.status)}</span>
      </div>
      <button
        type="button"
        className={styles.handoffCardBtn}
        onClick={() => requestOpenTask(taskId)}
        data-testid="handoff-open-task"
      >
        {t('ui.providers-schedule.task-view-in-board')}
      </button>
    </div>
  );
};

export const nomiSlots: ConvSlots = {
  before: (m) => {
    const raw = rawOf(m);
    if (!raw) return null;
    return (
      <>
        {m.role === 'user' && raw.delegateTo && (
          <span className={styles.kbTag} data-testid="message-delegate-to">
            {t('ui.session-workspace.to', t(ENDPOINT_NAME[raw.delegateTo]))}
          </span>
        )}
        {m.role === 'assistant' && !!raw.memories?.length && (
          <Disclosure
            className={styles.stepRow}
            summaryClassName={styles.stepSummary}
            data-testid="memory-tag"
            summary={
              <>
                {t('ui.providers-schedule.used')} {raw.memories.length}{' '}
                {t('ui.providers-schedule.memories')}
              </>
            }
          >
            <ul className={styles.stepBody}>
              {raw.memories.map((mem) => (
                <li key={mem.id}>{t(mem.title)}</li>
              ))}
            </ul>
          </Disclosure>
        )}
        {!!raw.images?.length && <UserImages images={raw.images} />}
      </>
    );
  },
  body: (m) => {
    const raw = rawOf(m);
    return m.role === 'assistant' && raw?.sources?.length ? <CitedBody message={raw} /> : null;
  },
  after: (m) => {
    const raw = rawOf(m);
    if (m.role !== 'assistant' || !raw) return null;
    if (raw.handoffTaskId) return <HandoffTaskCard taskId={raw.handoffTaskId} />;
    // 委派结果：子任务改的文件（+/− 与每个文件的 Diff），和子任务面板里同一张卡片
    if (raw.delegateChanges?.files.length)
      return <DelegateChangesCard messageId={m.id} changes={raw.delegateChanges} />;
    return raw.kb && !raw.sources?.length ? (
      <span className={styles.kbTag}>{t('ui.foundation.knowledge-base')}</span>
    ) : null;
  },
};
