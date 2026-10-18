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

import { CitedText, SourceList, SourcePreview } from './Citations';
import styles from './Citations.module.css';
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
      <div className={styles.contentText}>
        <CitedText text={message.content} sources={sources} onPick={setPick} />
      </div>
      <details className={styles.stepRow} open>
        <summary>
          <Icon icon={ChevronRight} size={12} className={styles.stepIcon} />
          {message.kb ? t('知识库') : t('来源')} · {sources.length} {t('处出处')}
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
        {m.role === 'assistant' && !!raw.memories?.length && (
          <details className={styles.stepRow} data-testid="memory-tag">
            <summary>
              <Icon icon={ChevronRight} size={12} className={styles.stepIcon} />
              {t('参考了')} {raw.memories.length} {t('条记忆')}
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
                alt={im.source === 'snip' ? t('截图') : t('图片')}
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
      <span className={styles.kbTag}>{t('知识库')}</span>
    ) : null;
  },
};
