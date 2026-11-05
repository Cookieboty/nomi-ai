import { ErrorState, LoadingState, t } from '@nomi-ai/ui';
import React from 'react';

import styles from './index.module.css';

export type BootScreenState =
  | { kind: 'loading' }
  | { kind: 'migrating'; done: number; total: number }
  | { kind: 'failed'; retrying?: boolean };

/**
 * 对话窗口的启动画面：会话存储准备好之前（main.tsx）先画这一屏，不白屏。
 * 读不到对话记录时显示错误与「重试」，不显示空列表（看起来像记录丢了）。
 */
export const BootScreen: React.FC<{ state: BootScreenState; onRetry?: () => void }> = ({
  state,
  onRetry,
}) => (
  <div className={styles.root} data-testid="boot-screen">
    <div className={styles.drag} aria-hidden />
    <div className={styles.body}>
      {state.kind === 'failed' ? (
        <ErrorState
          title={t('ui.chat-settings.boot-history-unavailable')}
          detail={t('ui.chat-settings.boot-history-unavailable-detail')}
          {...(onRetry ? { onRetry } : {})}
          retrying={!!state.retrying}
          data-testid="boot-error"
          retryTestId="boot-retry"
        />
      ) : (
        <div role="status" aria-live="polite" className={styles.loading} data-testid="boot-loading">
          <LoadingState
            rows={3}
            label={
              state.kind === 'migrating'
                ? t('ui.chat-settings.boot-importing-history', state.done, state.total)
                : t('ui.chat-settings.boot-loading-history')
            }
          />
        </div>
      )}
    </div>
  </div>
);
