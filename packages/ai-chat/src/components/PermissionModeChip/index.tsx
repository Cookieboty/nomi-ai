/**
 * 输入栏的权限模式按钮（docs/design/cli-permission-modes.md §4）：
 * - 点开下拉选档位；只列当前编程助手支持的档位（不支持的不显示，选了也没意义）；
 * - 输入框里 Shift+Tab 在支持的档位间循环，跳过「完全放开」；
 * - 「完全放开」只能从下拉进入，先确认；之后按钮标红；
 * - 下拉底部可以把当前档设为新标签的默认档（「完全放开」不能设为默认）。
 */
import { Button, Icon, Modal, t } from '@nomi-ai/ui';
import {
  Check,
  ChevronDown,
  ClipboardList,
  FilePen,
  Hand,
  ShieldAlert,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { harnessClient, type HarnessTabMeta } from '../../services/harnessClient';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import {
  CYCLE_PERMISSION_EVENT,
  PERMISSION_MODES,
  modeHint,
  modeLabel,
  nextMode,
  supportedModes,
  type CyclePermissionDetail,
  type PermissionMode,
} from '../../utils/permissionModes';

import styles from './index.module.css';

const ICON: Record<PermissionMode, LucideIcon> = {
  plan: ClipboardList,
  manual: Hand,
  acceptEdits: FilePen,
  auto: Sparkles,
  bypass: ShieldAlert,
};

export const PermissionModeChip: React.FC<{
  tab: HarnessTabMeta;
  defaultMode?: PermissionMode;
}> = ({ tab, defaultMode }) => {
  const [open, setOpen] = useState(false);
  const [confirmBypass, setConfirmBypass] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<React.CSSProperties>({});

  // 菜单挂到 body、fixed 定位、向上弹出：输入栏左侧容器是 overflow: hidden，挂在里面会被裁掉
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - 328));
    setPos({ left, bottom: window.innerHeight - r.top + 6 });
  }, [open]);
  const backend = tab.backend;
  const mode: PermissionMode = tab.permissionMode ?? 'acceptEdits';
  const supported = supportedModes(backend);
  const name = backend === 'nomi' ? '' : ENDPOINT_NAME[backend];

  const apply = async (next: PermissionMode, confirmed = false) => {
    setNote(null);
    try {
      const r = await harnessClient.setTabPermissionMode(tab.id, next, { confirmed });
      if (r.degraded && r.permissionMode)
        setNote(
          t('{0} 不支持「{1}」，已使用「{2}」', name, modeLabel(next), modeLabel(r.permissionMode)),
        );
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  };

  const pick = (m: PermissionMode) => {
    setOpen(false);
    btnRef.current?.focus();
    if (m === mode) return;
    if (m === 'bypass') setConfirmBypass(true);
    else void apply(m);
  };

  // 输入框 Shift+Tab：循环切换（不经过「完全放开」）
  useEffect(() => {
    const onCycle = (e: Event) => {
      const detail = (e as CustomEvent<CyclePermissionDetail>).detail;
      const next = nextMode(backend, mode === 'bypass' ? 'acceptEdits' : mode);
      if (!next) return;
      detail.handled = true;
      void apply(next);
    };
    window.addEventListener(CYCLE_PERMISSION_EVENT, onCycle);
    return () => window.removeEventListener(CYCLE_PERMISSION_EVENT, onCycle);
    // apply 每次渲染都是新函数；只需要跟着档位 / 标签变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, mode, tab.id]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent) {
        if (e.key !== 'Escape') return;
        setOpen(false);
        btnRef.current?.focus();
        return;
      }
      const target = e.target as Node;
      if (ref.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [open]);

  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 5000);
    return () => clearTimeout(id);
  }, [note]);

  const danger = mode === 'bypass';

  return (
    <div className={styles.wrap} ref={ref}>
      <button
        ref={btnRef}
        type="button"
        className={`${styles.chip} ${danger ? styles.danger : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('权限模式：{0}', modeLabel(mode))}
        title={t('{0}（Shift+Tab 切换）', modeHint(mode))}
        data-testid="permission-mode-chip"
        data-mode={mode}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon icon={ICON[mode]} size={14} />
        <span className={styles.label}>{modeLabel(mode)}</span>
        <Icon icon={ChevronDown} size={12} />
      </button>
      {note && (
        <span className={styles.note} role="status" data-testid="permission-mode-note">
          {note}
        </span>
      )}
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className={styles.menu}
            style={pos}
            role="menu"
            aria-label={t('权限模式')}
            data-testid="permission-mode-menu"
          >
            {PERMISSION_MODES.filter((m) => supported.includes(m)).map((m) => (
              <button
                key={m}
                type="button"
                role="menuitemradio"
                aria-checked={mode === m}
                className={`${styles.item} ${m === 'bypass' ? styles.itemDanger : ''}`}
                data-testid={`permission-mode-${m}`}
                onClick={() => pick(m)}
              >
                <span className={styles.itemIcon}>
                  <Icon icon={ICON[m]} size={15} />
                </span>
                <span className={styles.itemText}>
                  <span className={styles.itemLabel}>{modeLabel(m)}</span>
                  <span className={styles.itemHint}>{modeHint(m)}</span>
                </span>
                {mode === m && (
                  <span className={styles.itemCheck}>
                    <Icon icon={Check} size={14} />
                  </span>
                )}
              </button>
            ))}
            <div className={styles.foot}>
              <span>
                <kbd className={styles.kbd}>Shift+Tab</kbd> {t('在输入框里切换')}
              </span>
              {mode !== 'bypass' && mode !== defaultMode && (
                <button
                  type="button"
                  className={styles.link}
                  data-testid="permission-mode-make-default"
                  onClick={() => {
                    setOpen(false);
                    void harnessClient
                      .setPermissionDefaults({ defaultPermissionMode: mode })
                      .then(() => setNote(t('新标签默认使用「{0}」', modeLabel(mode))))
                      .catch(() => undefined);
                  }}
                >
                  {t('设为新标签默认')}
                </button>
              )}
            </div>
          </div>,
          document.body,
        )}
      {confirmBypass && (
        <Modal
          open
          onClose={() => setConfirmBypass(false)}
          title={t('切换到「完全放开」？')}
          closeLabel={t('取消')}
          data-testid="permission-bypass-confirm"
          footer={
            <div className={styles.actions}>
              <Button onClick={() => setConfirmBypass(false)}>{t('取消')}</Button>
              <Button
                variant="danger"
                data-testid="permission-bypass-ok"
                onClick={() => {
                  setConfirmBypass(false);
                  void apply('bypass', true);
                }}
              >
                {t('完全放开')}
              </Button>
            </div>
          }
        >
          <p>
            {t(
              '{0} 将不再询问，可以修改任何文件、运行任何命令（包括工作目录之外）。只建议在隔离环境里使用。这个设置只对当前标签生效，重启 Nomi 后会恢复为默认档。',
              name,
            )}
          </p>
        </Modal>
      )}
    </div>
  );
};
