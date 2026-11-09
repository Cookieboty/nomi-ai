/**
 * 选项目：显示当前项目名（多个文件夹时带「+N」，悬停看全部文件夹）；菜单里可以搜索、切换、新建项目，
 * 可选「不使用项目」。受控组件：由调用方决定如何应用（Nomi 对话改会话的 projectId / 编程助手标签换项目 /
 * 新会话的初始项目）。
 */
import { Icon, t, useLocale } from '@nomi-ai/ui';
import { Check, Folder, FolderX, Search, SquarePen } from 'lucide-react';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { projectRoots, projectTitle, useProjects } from '../../services/projects';
import { ProjectDialog } from '../ProjectDialog';

import styles from './index.module.css';

export const ProjectPicker: React.FC<{
  value: string | undefined;
  onChange: (projectId: string) => void | Promise<void>;
  disabled?: boolean;
  /** 菜单向上展开（输入栏里） */
  up?: boolean;
  testId?: string;
  className?: string;
  size?: 'sm' | 'ms';
  variant?: 'outline' | 'ghost';
  /** 可以不用项目：菜单底部多一项「不使用项目」；没有值时按钮显示 emptyLabel */
  onClear?: () => void;
  emptyLabel?: string;
}> = ({
  value,
  onChange,
  disabled,
  up = false,
  testId = 'project-picker',
  className,
  size = 'sm',
  variant = 'outline',
  onClear,
  emptyLabel,
}) => {
  useLocale();
  const projects = useProjects();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<React.CSSProperties>({});
  const current = value ? projects.find((p) => p.id === value) : undefined;

  // 菜单挂到 body 并用 fixed 定位：输入栏容器有 overflow / backdrop-filter，会把菜单裁掉
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - 436));
    setPos(up ? { left, bottom: window.innerHeight - r.top + 4 } : { left, top: r.bottom + 4 });
  }, [open, up]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onDown = (e: MouseEvent) => {
      const el = e.target as Node;
      if (!ref.current?.contains(el) && !menuRef.current?.contains(el)) setOpen(false);
    };
    const onScroll = (e: Event) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const shown = q
    ? projects.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          projectRoots(p).some((d) => d.toLowerCase().includes(q)),
      )
    : projects;
  const apply = (id: string) => {
    setOpen(false);
    if (id !== value) void onChange(id);
  };
  const extra = current ? current.folders.length : 0;
  const label = current?.name || emptyLabel || t('ui.cli-monitor.project-choose');

  return (
    <span className={`${styles.wrap} ${className ?? ''}`} ref={ref} data-testid={testId}>
      <button
        type="button"
        className={styles.chip}
        data-size={size}
        data-variant={variant}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('ui.cli-monitor.project-current', label)}
        title={current ? projectTitle(current) : t('ui.cli-monitor.project-choose')}
        data-testid={`${testId}-button`}
        onClick={() => {
          setQuery('');
          setOpen((v) => !v);
        }}
      >
        <Icon icon={Folder} size={14} />
        <span className={styles.path} data-testid={`${testId}-name`}>
          {label}
        </span>
        {extra > 0 && <span className={styles.count}>+{extra}</span>}
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
            <label className={styles.search}>
              <Icon icon={Search} size={14} />
              <input
                className={styles.searchInput}
                value={query}
                autoFocus
                placeholder={t('ui.cli-monitor.project-search')}
                aria-label={t('ui.cli-monitor.project-search')}
                data-testid={`${testId}-search`}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && shown[0]) apply(shown[0].id);
                }}
              />
            </label>
            {projects.length === 0 && (
              <div className={styles.empty}>{t('ui.cli-monitor.project-none-yet')}</div>
            )}
            {shown.map((p) => (
              <button
                key={p.id}
                type="button"
                role="menuitemradio"
                aria-checked={p.id === value}
                className={styles.item}
                title={projectTitle(p)}
                data-testid="project-picker-item"
                onClick={() => apply(p.id)}
              >
                <Icon icon={Folder} size={14} />
                <span className={styles.itemPath}>{p.name}</span>
                {p.folders.length > 0 && <span className={styles.count}>+{p.folders.length}</span>}
                <span className={styles.checkEnd}>
                  {p.id === value ? <Icon icon={Check} size={14} /> : null}
                </span>
              </button>
            ))}
            <button
              type="button"
              role="menuitem"
              className={`${styles.item} ${styles.browse}`}
              data-testid={`${testId}-new`}
              onClick={() => {
                setOpen(false);
                setCreating(true);
              }}
            >
              <span className={styles.check}>
                <Icon icon={SquarePen} size={14} />
              </span>
              {t('ui.cli-monitor.project-new-ellipsis')}
            </button>
            {onClear && value && (
              <button
                type="button"
                role="menuitem"
                className={styles.item}
                data-testid={`${testId}-clear`}
                onClick={() => {
                  setOpen(false);
                  onClear();
                }}
              >
                <span className={styles.check}>
                  <Icon icon={FolderX} size={14} />
                </span>
                {t('ui.cli-monitor.no-project')}
              </button>
            )}
          </div>,
          document.body,
        )}
      {creating && (
        <ProjectDialog onClose={() => setCreating(false)} onSaved={(p) => void onChange(p.id)} />
      )}
    </span>
  );
};
