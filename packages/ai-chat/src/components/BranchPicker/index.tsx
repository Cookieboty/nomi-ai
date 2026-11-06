/**
 * 分支切换（Codex 式）：按钮显示当前分支，点开是可搜索的本地分支列表（当前分支打勾），
 * 底部「创建并检出新分支…」。新会话输入框上方的工作区条与右栏「改动」顶部共用。
 * 有会被覆盖的未提交改动时 git 会拒绝切换（不丢改动），错误留在菜单里，可以改了再试。
 */
import { Icon, t } from '@nomi-ai/ui';
import { Check, GitBranch, Plus, Search } from 'lucide-react';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { GIT_BRANCH_CHANGED_EVENT } from '../../services/gitEvents';
import { harnessClient, type GitBranchList, type GitOpCode } from '../../services/harnessClient';
import { promptDialog } from '../ConfirmDialog';
import { gitErrorText } from '../SessionWorkspace/GitCommitBox';

import styles from './index.module.css';

const baseName = (p: string) =>
  p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || p;

/** 切换 / 新建分支失败的说明：切换特有的几种，其余沿用右栏 git 操作的文案 */
export function checkoutErrorText(code: GitOpCode | undefined): string {
  switch (code) {
    case 'dirty':
      return t('ui.session-workspace.git-error-checkout-dirty');
    case 'exists':
      return t('ui.session-workspace.git-error-branch-exists');
    case 'invalid':
      return t('ui.session-workspace.git-error-branch-invalid');
    default:
      return gitErrorText(code);
  }
}

export const BranchPicker: React.FC<{
  cwd: string;
  /** 当前分支（按钮上显示）；还没读到时为空 */
  branch: string | null;
  /** 菜单向上展开（输入框上方） */
  up?: boolean;
  /** 正在跑（助手可能在改仓库）：不让切 */
  disabled?: boolean;
  className?: string;
  testId?: string;
  /** 切换成功后（例如右栏据此重读改动） */
  onSwitched?: (branch: string) => void;
}> = ({ cwd, branch, up = false, disabled, className, testId = 'branch-picker', onSwitched }) => {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<GitBranchList | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<React.CSSProperties>({});

  // 菜单挂到 body 并用 fixed 定位：输入框一带与右栏都有 overflow，会把菜单裁掉
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - 336));
    setPos(up ? { left, bottom: window.innerHeight - r.top + 4 } : { left, top: r.bottom + 4 });
  }, [open, up]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void harnessClient
      .gitBranches(cwd)
      .then((l) => alive && setList(l))
      .catch(() => alive && setList(null));
    const onDown = (e: MouseEvent) => {
      const el = e.target as Node;
      if (!ref.current?.contains(el) && !menuRef.current?.contains(el)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      alive = false;
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, cwd]);

  const current = list?.current ?? branch;
  const q = query.trim().toLowerCase();
  const shown = (list?.branches ?? []).filter((b) => !q || b.toLowerCase().includes(q));

  const checkout = async (name: string, create: boolean) => {
    if (!create && name === current) {
      setOpen(false);
      return;
    }
    setBusy(true);
    setError(null);
    const r = await harnessClient
      .gitCheckout(cwd, name, create)
      .catch(() => ({ ok: false, code: 'error' as const }));
    setBusy(false);
    if (!r.ok) {
      setError(checkoutErrorText(r.code));
      return;
    }
    setOpen(false);
    window.dispatchEvent(new CustomEvent(GIT_BRANCH_CHANGED_EVENT, { detail: { cwd } }));
    onSwitched?.(name);
  };
  const createNew = async () => {
    const name = (
      await promptDialog({
        title: t('ui.session-workspace.create-and-checkout-branch'),
        label: t('ui.session-workspace.new-branch-name'),
        defaultValue: query.trim(),
      })
    )?.trim();
    if (name) await checkout(name, true);
  };

  const label = branch ?? list?.detached ?? '';
  return (
    <span className={`${styles.wrap} ${className ?? ''}`} ref={ref} data-testid={testId}>
      <button
        type="button"
        className={styles.chip}
        disabled={disabled || !label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('ui.session-workspace.switch-branch', label)}
        title={t('ui.session-workspace.current-branch', label)}
        data-testid={`${testId}-button`}
        onClick={() => {
          setQuery('');
          setError(null);
          setOpen((v) => !v);
        }}
      >
        <Icon icon={GitBranch} size={14} />
        <span className={styles.name}>{label}</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className={styles.menu}
            style={pos}
            role="menu"
            aria-busy={busy}
            data-testid={`${testId}-menu`}
          >
            <label className={styles.search}>
              <Icon icon={Search} size={14} />
              <input
                className={styles.searchInput}
                value={query}
                autoFocus
                placeholder={t('ui.session-workspace.search-branches', baseName(cwd))}
                aria-label={t('ui.session-workspace.search-branches', baseName(cwd))}
                data-testid={`${testId}-search`}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && shown[0]) void checkout(shown[0], false);
                }}
              />
            </label>
            <div className={styles.group}>{t('ui.session-workspace.branches')}</div>
            <div className={styles.list}>
              {list && shown.length === 0 && (
                <div className={styles.empty}>{t('ui.session-workspace.no-matching-branches')}</div>
              )}
              {shown.map((b) => (
                <button
                  key={b}
                  type="button"
                  role="menuitemradio"
                  aria-checked={b === current}
                  className={styles.item}
                  disabled={busy}
                  title={b}
                  data-testid="branch-item"
                  onClick={() => void checkout(b, false)}
                >
                  <Icon icon={GitBranch} size={14} />
                  <span className={styles.itemName}>{b}</span>
                  <span className={styles.check}>
                    {b === current ? <Icon icon={Check} size={14} /> : null}
                  </span>
                </button>
              ))}
            </div>
            {error && (
              <p className={styles.error} role="alert" data-testid={`${testId}-error`}>
                {error}
              </p>
            )}
            <button
              type="button"
              role="menuitem"
              className={`${styles.item} ${styles.create}`}
              disabled={busy}
              data-testid={`${testId}-create`}
              onClick={() => void createNew()}
            >
              <Icon icon={Plus} size={14} />
              <span className={styles.itemName}>
                {t('ui.session-workspace.create-and-checkout-branch-ellipsis')}
              </span>
            </button>
          </div>,
          document.body,
        )}
    </span>
  );
};
