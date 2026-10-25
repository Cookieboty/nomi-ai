/**
 * Nomi 普通对话在统一会话视图里的扩展内容：参考记忆、图片、知识库引用 / 来源、知识库标签。
 * 这些是 Nomi 独有的数据（ChatMessage.raw），视图本身只认统一的 ConvMessage。
 */
import { Icon, t } from '@nomi-ai/ui';
import { ChevronRight } from 'lucide-react';
import React, { useState } from 'react';

import type { KbSource } from '../../services/kbClient';
import type { ChatMessage } from '../../types/chat';
import type { ConvMessage } from '../../types/conversation';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';

import { SourceList, SourcePreview } from './Citations';
import styles from './Citations.module.css';
import { CiteProvider } from './citeRefs';
import { Markdown } from './Markdown';
import type { ConvSlots } from './Messages';

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
      <details className={styles.stepRow} open>
        <summary>
          <Icon icon={ChevronRight} size={12} className={styles.stepIcon} />
          {message.kb ? t('ui.foundation.knowledge-base') : t('ui.knowledge-local.sources')} ·{' '}
          {sources.length} {t('ui.providers-schedule.sources-f358a7')}
        </summary>
        <SourceList sources={sources} onPick={setPick} />
      </details>
      <SourcePreview source={pick} onClose={() => setPick(null)} />
    </>
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
          <details className={styles.stepRow} data-testid="memory-tag">
            <summary>
              <Icon icon={ChevronRight} size={12} className={styles.stepIcon} />
              {t('ui.providers-schedule.used')} {raw.memories.length}{' '}
              {t('ui.providers-schedule.memories')}
            </summary>
            <ul className={styles.stepBody}>
              {raw.memories.map((mem) => (
                <li key={mem.id}>{t(mem.title)}</li>
              ))}
            </ul>
          </details>
        )}
        {!!raw.images?.length && (
          <div className={styles.imageRow} data-testid="message-images">
            {raw.images.map((im, i) => (
              <img
                key={i}
                src={im.thumb}
                alt={
                  im.source === 'snip'
                    ? t('ui.providers-schedule.screenshot')
                    : t('ui.providers-schedule.image')
                }
                className={styles.imageThumb}
                title={`${im.width}×${im.height}`}
              />
            ))}
          </div>
        )}
      </>
    );
  },
  body: (m) => {
    const raw = rawOf(m);
    return m.role === 'assistant' && raw?.sources?.length ? <CitedBody message={raw} /> : null;
  },
  after: (m) => {
    const raw = rawOf(m);
    return m.role === 'assistant' && raw?.kb && !raw.sources?.length ? (
      <span className={styles.kbTag}>{t('ui.foundation.knowledge-base')}</span>
    ) : null;
  },
};
