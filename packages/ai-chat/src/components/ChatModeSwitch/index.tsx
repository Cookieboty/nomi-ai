/**
 * 顶栏左侧：普通模式 / 开发模式。
 * 普通隐藏 CLI 标签栏、后端切换与 Mod+T；后台 CLI 仍运行，徽标提示「N 运行中」。
 */
import { t, Tooltip } from '@nomi-ai/ui';
import React, { useMemo } from 'react';

import { useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { useChatMode } from '../../hooks/useChatMode';
import { MAIN_TAB_ID } from '../../services/harnessClient';

import styles from './index.module.css';

export const ChatModeSwitch: React.FC = () => {
  const { mode, setMode } = useChatMode();
  const tabs = useHarnessTabs();

  const runningCount = useMemo(() => {
    const list = tabs.state?.tabs ?? [];
    return list.filter(
      (x) => x.id !== MAIN_TAB_ID && (x.status === 'running' || x.status === 'queued'),
    ).length;
  }, [tabs.state]);

  const tip =
    mode === 'normal'
      ? t('普通模式：仅 Nomi 对话。切换到开发模式可使用 Claude Code / Codex / dsh 标签。')
      : t('开发模式：可用编程助手标签、后端切换与监视器联动。');

  return (
    <div className={styles.wrap} data-testid="chat-mode-switch">
      {/* 开关贴着对话区左缘：提示左对齐，不压到侧栏上 */}
      <Tooltip placement="bottom-start" content={tip}>
        <div className={styles.seg} role="group" aria-label={t('对话模式')}>
          <button
            type="button"
            className={styles.btn}
            aria-pressed={mode === 'normal'}
            data-testid="chat-mode-normal"
            onClick={() => setMode('normal')}
          >
            {t('普通')}
          </button>
          <button
            type="button"
            className={styles.btn}
            aria-pressed={mode === 'dev'}
            data-testid="chat-mode-dev"
            onClick={() => setMode('dev')}
          >
            {t('开发')}
          </button>
        </div>
      </Tooltip>
      {mode === 'normal' && runningCount > 0 && (
        <span
          className={styles.badge}
          data-testid="chat-mode-running-badge"
          title={t('有编程助手标签仍在后台运行')}
        >
          {t('{0} 运行中', runningCount)}
        </span>
      )}
    </div>
  );
};
