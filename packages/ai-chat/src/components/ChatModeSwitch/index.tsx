/**
 * 侧栏 Nomi 标志右侧：助手模式 / 工作台模式（内部值 normal / dev）。
 * 助手模式隐藏 CLI 标签栏与 Mod+T；后台 CLI 仍运行，徽标显示运行中的数量。
 */
import { getLocale, t } from '@nomi-ai/ui';
import React, { useMemo } from 'react';

import { useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { useChatMode } from '../../hooks/useChatMode';
import { MAIN_TAB_ID } from '../../services/harnessClient';

import styles from './index.module.css';

/**
 * 模式按钮文案。「助手」在词典里已被服务商页的「Assistants」占用（词典按原文去重、无上下文），
 * 所以这两个短标签不走词典，按界面语言直接取。
 */
const modeLabel = (zh: string, en: string): string => (getLocale() === 'zh-CN' ? zh : en);

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
      ? t('ui.cli-monitor.assistant-mode-chat-with-nomi-only-switch-to')
      : t('ui.cli-monitor.workbench-mode-coding-agent-tabs-backend-switcher-and');

  return (
    <div className={styles.wrap} data-testid="chat-mode-switch">
      {/* 侧栏 overflow: hidden 会裁掉 CSS 提示，这里用原生 title */}
      <div
        className={styles.seg}
        role="group"
        aria-label={t('ui.cli-monitor.chat-mode')}
        title={tip}
      >
        <button
          type="button"
          className={styles.btn}
          aria-pressed={mode === 'normal'}
          data-testid="chat-mode-normal"
          onClick={() => setMode('normal')}
        >
          {modeLabel('助手', 'Assistant') /* i18n-ignore */}
        </button>
        <button
          type="button"
          className={styles.btn}
          aria-pressed={mode === 'dev'}
          data-testid="chat-mode-dev"
          onClick={() => setMode('dev')}
        >
          {modeLabel('工作台', 'Workbench') /* i18n-ignore */}
        </button>
      </div>
      {mode === 'normal' && runningCount > 0 && (
        <span
          className={styles.badge}
          data-testid="chat-mode-running-badge"
          title={`${t('ui.foundation.coding-tabs-still-running-in-background')} · ${t('ui.session-workspace.running', runningCount)}`}
        >
          {runningCount}
        </span>
      )}
    </div>
  );
};
