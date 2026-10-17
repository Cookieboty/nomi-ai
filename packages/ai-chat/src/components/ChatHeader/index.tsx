/**
 * 对话窗口顶栏（参考 Codex app：右上角放常用入口，下面是对话）。
 * 图标打开右侧快速视图（抽屉），详细配置在「设置」里。
 */
import { t, Icon } from '@nomi-ai/ui';
import { Tooltip } from '@nomi-ai/ui';
import {
  Ellipsis,
  Pin,
  Settings2,
  Blocks,
  Cpu,
  LibraryBig,
  Settings,
  type LucideIcon,
} from 'lucide-react';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { extClient } from '../../services/extClient';
import { kbClient } from '../../services/kbClient';
import { memClient } from '../../services/memClient';
import { MAX_PINS, pinDef, pinHint, runPinCommand, togglePin, usePins } from '../../services/pins';
import { schedClient } from '../../services/schedClient';
import { formatCombo, useShortcutBindings } from '../../services/shortcuts';
import { AppIcon } from '../AppIcons';
import { ChatModeSwitch } from '../ChatModeSwitch';

import styles from './index.module.css';

const I: Record<string, LucideIcon> = {
  hub: LibraryBig,
  ext: Blocks,
  local: Cpu,
  settings: Settings,
};

interface Props {
  /** 知识 · 记忆 · 日程 快速视图 */
  onHub: () => void;
  onExt: () => void;
  onLocal: () => void;
  onSettings: () => void;
  onNewChat: () => void;
  /** 打开 设置 → 通用 → 常驻入口 */
  onCustomize?: () => void;
  children?: React.ReactNode;
}

export const ChatHeader: React.FC<Props> = (p) => {
  const bindings = useShortcutBindings();
  const items = [
    {
      k: 'hub',
      tip: t('知识 · 记忆 · 日程'),
      key: formatCombo(bindings.hub),
      id: 'open-hub-panel',
      pin: 'hub',
      on: p.onHub,
      show: memClient.available() || kbClient.available() || schedClient.available(),
    },
    {
      k: 'ext',
      tip: t('扩展 / MCP'),
      key: formatCombo(bindings.ext),
      id: 'open-ext-panel',
      pin: 'ext',
      on: p.onExt,
      show: extClient.available(),
    },
    {
      k: 'local',
      tip: t('本机管理（剪贴板 · 导出 · 小模型 · Ollama）'),
      key: formatCombo(bindings.local),
      id: 'open-local-panel',
      pin: 'local',
      on: p.onLocal,
      show: extClient.available(),
    },
    {
      k: 'settings',
      tip: t('设置'),
      key: formatCombo(bindings.settings),
      id: 'open-settings',
      pin: 'settings',
      on: p.onSettings,
      show: true,
    },
  ].filter((i) => i.show);
  const { pins, update } = usePins();
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [more, setMore] = useState(false);
  const leftRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1000);
  useLayoutEffect(() => {
    const el = leftRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e!.contentRect.width));
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width || 1000);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (!menu && !more) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e instanceof MouseEvent && (e.target as Element).closest?.('[data-pin-popup]')) return;
      setMenu(null);
      setMore(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
      window.removeEventListener('blur', close);
    };
  }, [menu, more]);

  // 窄窗口：放不下的入口收进「⋯」
  const SLOT = 34;
  const fit =
    pins.length * SLOT <= width ? pins.length : Math.max(0, Math.floor((width - SLOT) / SLOT));
  const shown = pins.slice(0, fit);
  const hidden = pins.slice(fit);
  const run = (id: string) => {
    setMore(false);
    if (id === 'newchat') p.onNewChat();
    else runPinCommand(id);
  };
  const ctx = (id: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    setMore(false);
    setMenu({ id, x: e.clientX, y: e.clientY });
  };
  const ctxPinned = menu ? pins.includes(menu.id) : false;
  const ctxFull = !ctxPinned && pins.length >= MAX_PINS;

  return (
    <header className={styles.header} data-testid="chat-header">
      <div className={styles.left} ref={leftRef} data-testid="header-pins">
        <ChatModeSwitch />
        {shown.map((id) => {
          const d = pinDef(id)!;
          return (
            <Tooltip
              key={id}
              placement="bottom"
              content={pinHint(d) ? `${t(d.label)}  ${pinHint(d)}` : t(d.label)}
            >
              <button
                type="button"
                className={`${styles.btn} ${styles.pin}`}
                onClick={() => run(id)}
                onContextMenu={ctx(id)}
                aria-label={t(d.label)}
                data-testid={`pin-${id}`}
              >
                <span aria-hidden>
                  <AppIcon icon={d.icon} size={16} />
                </span>
              </button>
            </Tooltip>
          );
        })}
        {hidden.length > 0 && (
          <div className={styles.moreWrap}>
            <button
              type="button"
              className={styles.btn}
              onClick={() => setMore((v) => !v)}
              aria-label={t('更多入口（{0}）', hidden.length)}
              aria-expanded={more}
              title={t('更多入口')}
              data-testid="pins-overflow"
            >
              <Icon icon={Ellipsis} />
            </button>
            {more && (
              <div className={styles.popup} role="menu" data-pin-popup>
                {hidden.map((id) => {
                  const d = pinDef(id)!;
                  return (
                    <button
                      key={id}
                      type="button"
                      role="menuitem"
                      className={styles.popItem}
                      onClick={() => run(id)}
                      onContextMenu={ctx(id)}
                      data-testid={`pin-overflow-${id}`}
                    >
                      <span aria-hidden>
                        <AppIcon icon={d.icon} size={16} />
                      </span>
                      <span className={styles.popLabel}>{t(d.label)}</span>
                      {pinHint(d) && <span className={styles.popHint}>{pinHint(d)}</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
      {p.children}
      {menu && (
        <div
          className={`${styles.popup} ${styles.ctx}`}
          style={{ left: menu.x, top: menu.y }}
          role="menu"
          data-pin-popup
          data-testid="pin-context-menu"
        >
          <button
            type="button"
            role="menuitem"
            className={styles.popItem}
            disabled={ctxFull}
            onClick={() => {
              update(togglePin(pins, menu.id));
              setMenu(null);
            }}
            data-testid={ctxPinned ? 'pin-unpin' : 'pin-pin'}
          >
            <Icon icon={Pin} />
            {ctxPinned
              ? t('取消固定')
              : ctxFull
                ? t('左上角已满（最多 {0} 个）', MAX_PINS)
                : t('固定到左上角')}
          </button>
          <button
            type="button"
            role="menuitem"
            className={styles.popItem}
            onClick={() => {
              setMenu(null);
              p.onCustomize?.();
            }}
            data-testid="pin-customize"
          >
            <Icon icon={Settings2} />
            {t('自定义常驻入口…')}
          </button>
        </div>
      )}
      <div className={styles.actions}>
        {items.map((i) => (
          <Tooltip key={i.id} placement="bottom" content={`${i.tip}  ${i.key}`}>
            <button
              type="button"
              className={styles.btn}
              onClick={i.on}
              onContextMenu={ctx(i.pin)}
              aria-label={t(i.tip)}
              data-testid={i.id}
            >
              <Icon icon={I[i.k]!} size={17} />
            </button>
          </Tooltip>
        ))}
      </div>
    </header>
  );
};
