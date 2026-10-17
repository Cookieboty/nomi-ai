import { Modal, t } from '@nomi-ai/ui';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import styles from './index.module.css';

export interface PaletteCommand {
  id: string;
  /** 中文文案（i18n key） */
  label: string;
  group: string;
  hint?: string;
  run: () => void;
}

/** ⌘/Ctrl+K 命令面板：输入过滤，↑↓ 选择，Enter 执行，Esc 关闭。 */
export const CommandPalette: React.FC<{
  open: boolean;
  onClose: () => void;
  commands: PaletteCommand[];
}> = ({ open, onClose, commands }) => {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  // 打开面板时重置输入与选中项（渲染期根据 open 跳变处理，避免 effect 内 setState 触发级联渲染）
  const [prevOpen, setPrevOpen] = useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (open) {
      if (q !== '') setQ('');
      if (sel !== 0) setSel(0);
    }
  }
  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((c) =>
      [t(c.label), c.label, t(c.group)].some((s) => s.toLowerCase().includes(needle)),
    );
  }, [q, commands]);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${sel}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [sel]);
  const run = (c: PaletteCommand | undefined) => {
    if (!c) return;
    onClose();
    // 关闭后再执行：焦点已归还，命令自己决定焦点去向（例如聚焦输入框）
    setTimeout(c.run, 0);
  };
  return (
    <Modal open={open} onClose={onClose} title={t('命令面板')} data-testid="command-palette">
      <input
        data-autofocus
        className={styles.input}
        data-testid="palette-input"
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-list"
        aria-activedescendant={items[sel] ? `palette-${items[sel]!.id}` : undefined}
        aria-label={t('搜索命令')}
        placeholder={t('输入以搜索命令…')}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setSel(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSel((s) => Math.min(items.length - 1, s + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSel((s) => Math.max(0, s - 1));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            run(items[sel]);
          }
        }}
      />
      <ul id="palette-list" role="listbox" className={styles.list} ref={listRef}>
        {items.map((c, i) => (
          <li
            key={c.id}
            id={`palette-${c.id}`}
            role="option"
            aria-selected={i === sel}
            data-index={i}
            data-testid={`palette-item-${c.id}`}
            className={i === sel ? `${styles.item} ${styles.active}` : styles.item}
            onMouseEnter={() => setSel(i)}
            onClick={() => run(c)}
          >
            <span className={styles.group}>{t(c.group)}</span>
            <span className={styles.label}>{t(c.label)}</span>
            {c.hint && <kbd className={styles.kbd}>{c.hint}</kbd>}
          </li>
        ))}
        {!items.length && <li className={styles.empty}>{t('没有匹配的命令')}</li>}
      </ul>
    </Modal>
  );
};
