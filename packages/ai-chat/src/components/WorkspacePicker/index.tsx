/**
 * 工作目录选择：显示当前目录（缩短 + tooltip 完整路径），下拉里是最近使用的目录 + 「选择文件夹…」原生选择器。
 * 受控组件：由调用方决定如何应用（更改正在运行的 CLI 会话 / 新建标签时的初始目录）。
 */
import { t, Icon } from '@nomi-ai/ui';
import { Check, Folder, FolderOpen } from 'lucide-react';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { harnessClient } from '../../services/harnessClient';
import { shortenPath } from '../../utils/workspacePath';

import styles from './index.module.css';

export const WorkspacePicker: React.FC<{
  value: string;
  onChange: (cwd: string) => void | Promise<void>;
  disabled?: boolean;
  /** 菜单向上展开（输入栏里） */
  up?: boolean;
  label?: string;
  testId?: string;
  className?: string;
}> = ({ value, onChange, disabled, up = false, label, testId = 'workspace-picker', className }) => {
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const ref = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<React.CSSProperties>({});

  const onClose = () => setOpen(false);

  // 菜单挂到 body 并用 fixed 定位：输入栏容器有 overflow / backdrop-filter，会把菜单裁掉
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - 436));
    setPos(up ? { left, bottom: window.innerHeight - r.top + 4 } : { left, top: r.bottom + 4 });
  }, [open, up]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void harnessClient
      .recentCwds()
      .then((l) => alive && setRecent(l))
      .catch(() => undefined);
    const onDown = (e: MouseEvent) => {
      const el = e.target as Node;
      if (!ref.current?.contains(el) && !menuRef.current?.contains(el)) setOpen(false);
    };
    const onScroll = (e: Event) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('resize', onClose);
    window.addEventListener('scroll', onScroll, true);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      alive = false;
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const apply = (cwd: string) => {
    setOpen(false);
    if (cwd && cwd !== value) void onChange(cwd);
  };
  const browse = async () => {
    setOpen(false);
    const picked = await harnessClient.pickDir(value || undefined).catch(() => null);
    if (picked) apply(picked);
  };

  return (
    <span className={`${styles.wrap} ${className ?? ''}`} ref={ref} data-testid={testId}>
      <button
        type="button"
        className={styles.chip}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('工作目录：{0}', value || t('未设置'))}
        title={value ? [t('工作目录'), value].join('\n') : t('选择工作目录')}
        data-testid={`${testId}-button`}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon icon={Folder} />
        {label && <span className={styles.label}>{label}</span>}
        <span className={styles.path} data-testid={`${testId}-path`}>
          {shortenPath(value) || t('选择目录')}
        </span>
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className={styles.menu}
            style={pos}
            role="menu"
            data-testid={`${testId}-menu`}
          >
            {recent.length > 0 && <div className={styles.group}>{t('最近使用')}</div>}
            {recent.map((p) => (
              <button
                key={p}
                type="button"
                role="menuitemradio"
                aria-checked={p === value}
                className={styles.item}
                title={p}
                data-testid="workspace-recent-item"
                onClick={() => apply(p)}
              >
                <span className={styles.check}>
                  {p === value ? <Icon icon={Check} size={14} /> : null}
                </span>
                <span className={styles.itemPath}>{shortenPath(p, 44)}</span>
              </button>
            ))}
            <button
              type="button"
              role="menuitem"
              className={`${styles.item} ${styles.browse}`}
              data-testid="workspace-browse"
              onClick={() => void browse()}
            >
              <span className={styles.check}>
                <Icon icon={FolderOpen} size={14} />
              </span>
              {t('选择文件夹…')}
            </button>
          </div>,
          document.body,
        )}
    </span>
  );
};
