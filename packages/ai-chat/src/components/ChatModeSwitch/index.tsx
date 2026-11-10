/**
 * 侧栏顶部的模式菜单：「Nomi 助手 ⌄」/「Nomi 工作台 ⌄」（内部值 normal / dev）。
 * 助手模式隐藏 CLI 标签栏与 Mod+T；后台 CLI 仍运行，徽标显示运行中的数量。
 */
import { brand } from '@nomi-ai/types';
import { Icon, t, useLocale, usePresence } from '@nomi-ai/ui';
import { Check, ChevronDown } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import { useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { useChatMode } from '../../hooks/useChatMode';
import type { ChatMode } from '../../services/chatPrefs';
import { MAIN_TAB_ID, isNomiDelegated } from '../../services/harnessClient';

import styles from './index.module.css';

/** 模式名：产品名 + 助手 / 工作台 */
export const modeName = (mode: ChatMode): string =>
  mode === 'normal'
    ? t('ui.cli-monitor.mode-assistant', brand.appName)
    : t('ui.cli-monitor.mode-workbench', brand.appName);

const MODES: readonly ChatMode[] = ['normal', 'dev'];

export const ChatModeSwitch: React.FC = () => {
  useLocale();
  const { mode, setMode } = useChatMode();
  const tabs = useHarnessTabs();
  const [open, setOpen] = useState(false);
  // 收起时先放完淡出动画再卸载
  const menuP = usePresence(open);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const runningCount = useMemo(() => {
    const list = tabs.state?.tabs ?? [];
    return list.filter(
      (x) =>
        x.id !== MAIN_TAB_ID &&
        !isNomiDelegated(x) &&
        (x.status === 'running' || x.status === 'queued'),
    ).length;
  }, [tabs.state]);

  // 打开时焦点落在当前模式上；点外面关闭
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };
  const pick = (m: ChatMode) => {
    setMode(m);
    close(true);
  };
  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role=menuitemradio]') ?? [],
    );
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const n = (i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
    items[n]?.focus();
  };

  // 菜单里放短说明，长说明留给按钮的悬停提示
  const desc = (m: ChatMode) =>
    m === 'normal'
      ? t('ui.cli-monitor.mode-assistant-desc')
      : t('ui.cli-monitor.mode-workbench-desc');
  const tip =
    mode === 'normal'
      ? t('ui.cli-monitor.assistant-mode-chat-with-nomi-only-switch-to')
      : t('ui.cli-monitor.workbench-mode-coding-agent-tabs-backend-switcher-and');

  return (
    <div className={styles.wrap} ref={wrapRef} data-testid="chat-mode-switch">
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${t('ui.cli-monitor.chat-mode')}: ${modeName(mode)}`}
        title={tip}
        onClick={() => setOpen((v) => !v)}
        data-testid="chat-mode-trigger"
      >
        <span className={styles.name}>{modeName(mode)}</span>
        <Icon icon={ChevronDown} size={14} className={styles.chevron} />
      </button>
      {mode === 'normal' && runningCount > 0 && (
        <span
          className={styles.badge}
          data-testid="chat-mode-running-badge"
          title={`${t('ui.foundation.coding-tabs-still-running-in-background')} · ${t('ui.session-workspace.running', runningCount)}`}
        >
          {runningCount}
        </span>
      )}
      {menuP.value && (
        <div
          ref={menuRef}
          className={`${styles.menu} cd-motion-pop`}
          data-closing={menuP.closing || undefined}
          role="menu"
          aria-label={t('ui.cli-monitor.chat-mode')}
          onKeyDown={onMenuKey}
          data-testid="chat-mode-menu"
        >
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="menuitemradio"
              aria-checked={mode === m}
              className={styles.item}
              onClick={() => pick(m)}
              data-testid={m === 'normal' ? 'chat-mode-normal' : 'chat-mode-dev'}
            >
              <span className={styles.check} aria-hidden>
                {mode === m && <Icon icon={Check} size={14} />}
              </span>
              <span className={styles.itemText}>
                <span className={styles.itemName}>{modeName(m)}</span>
                <span className={styles.itemDesc}>{desc(m)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
