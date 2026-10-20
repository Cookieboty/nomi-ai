/**
 * 输入栏的权限模式按钮（docs/design/cli-permission-modes.md §4）：
 * - 点开下拉选档位；只列当前编程助手支持的档位（不支持的不显示，选了也没意义）；
 * - 输入框里 Shift+Tab 在支持的档位间循环，跳过「完全放开」；
 * - 「完全放开」只能从下拉进入，先确认；之后按钮标红。确认绑定发起时的标签（id / 后端 / 目录），
 *   确认框打开期间切走标签、关闭标签或换了后端 / 目录即作废，绝不转投到当前标签；
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

import {
  harnessClient,
  type HarnessBackend,
  type HarnessTabMeta,
} from '../../services/harnessClient';
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

function nativePermissionModes(
  values: readonly string[] | undefined,
  backend: HarnessBackend,
): PermissionMode[] | null {
  if (!values?.length) return null;
  const out: PermissionMode[] = [];
  for (const raw of values) {
    const v = raw.trim().toLowerCase();
    const mode =
      v === 'plan' || v === 'read-only' || v === 'readonly'
        ? 'plan'
        : v === 'manual' || v === 'default' || v === 'ask'
          ? 'manual'
          : v === 'on-request'
            ? backend === 'codex'
              ? 'auto'
              : 'manual'
            : v === 'acceptedits' || v === 'autoedit' || v === 'workspace-write'
              ? 'acceptEdits'
              : v === 'workspacewrite'
                ? 'acceptEdits'
                : v === 'auto' || v === 'dontask' || v === 'on_request'
                  ? 'auto'
                  : v === 'bypass' ||
                      v === 'bypasspermissions' ||
                      v === 'yolo' ||
                      v === 'danger-full-access' ||
                      v === 'dangerfullaccess'
                    ? 'bypass'
                    : null;
    if (mode && !out.includes(mode)) out.push(mode);
  }
  return out.length ? out : null;
}

/** 「完全放开」确认的目标：发起确认时的标签身份 */
interface BypassTarget {
  tabId: string;
  backend: HarnessBackend;
  cwd: string;
  title: string;
}

export const PermissionModeChip: React.FC<{
  tab: HarnessTabMeta;
  defaultMode?: PermissionMode;
}> = ({ tab, defaultMode }) => {
  const [open, setOpen] = useState(false);
  const [confirmBypass, setConfirmBypass] = useState<BypassTarget | null>(null);
  /** 提示只显示在产生它的标签上（异步结果回来时用户可能已切到别的标签） */
  const [note, setNote] = useState<{ tabId: string; text: string } | null>(null);
  const [cliModes, setCliModes] = useState<PermissionMode[] | null>(null);
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
  useEffect(() => {
    let alive = true;
    if (backend === 'nomi') {
      setCliModes(null);
      return;
    }
    void harnessClient
      .modelCatalog(backend as HarnessBackend)
      .then((catalog) => {
        if (alive) setCliModes(nativePermissionModes(catalog?.permissionModes, backend));
      })
      .catch(() => {
        if (alive) setCliModes(null);
      });
    return () => {
      alive = false;
    };
  }, [backend]);
  const supported = cliModes ?? supportedModes(backend);
  const name = backend === 'nomi' ? '' : ENDPOINT_NAME[backend];

  // 确认框打开期间显示的已不是发起确认的标签（切标签 / 关闭 / 换后端 / 换目录）：确认作废，
  // 不能把对 A 的确认用到 B 上。在渲染期按身份比对后清掉，切回 A 也不会复活旧确认框。
  const bypassTarget =
    confirmBypass &&
    confirmBypass.tabId === tab.id &&
    confirmBypass.backend === tab.backend &&
    confirmBypass.cwd === tab.cwd
      ? confirmBypass
      : null;
  if (confirmBypass && !bypassTarget) setConfirmBypass(null);

  /** target：「完全放开」确认时冻结的标签；主进程再核对一次后端 / 目录，变了就拒绝 */
  const apply = async (next: PermissionMode, target?: BypassTarget) => {
    const tabId = target?.tabId ?? tab.id;
    setNote(null);
    try {
      const r = await harnessClient.setTabPermissionMode(
        tabId,
        next,
        target
          ? { confirmed: true, expect: { backend: target.backend, cwd: target.cwd } }
          : { confirmed: false },
      );
      if (r.degraded && r.permissionMode)
        setNote({
          tabId,
          text: t(
            '{0} 不支持「{1}」，已使用「{2}」',
            name,
            modeLabel(next),
            modeLabel(r.permissionMode),
          ),
        });
    } catch (e) {
      setNote({ tabId, text: e instanceof Error ? e.message : String(e) });
    }
  };

  const pick = (m: PermissionMode) => {
    setOpen(false);
    btnRef.current?.focus();
    if (m === mode) return;
    if (m === 'bypass')
      setConfirmBypass({ tabId: tab.id, backend: tab.backend, cwd: tab.cwd, title: tab.title });
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
  const noteText = note && note.tabId === tab.id ? note.text : null;

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
      {noteText && (
        <span className={styles.note} role="status" data-testid="permission-mode-note">
          {noteText}
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
                    const tabId = tab.id;
                    void harnessClient
                      .setPermissionDefaults({ defaultPermissionMode: mode })
                      .then(() =>
                        setNote({ tabId, text: t('新标签默认使用「{0}」', modeLabel(mode)) }),
                      )
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
      {bypassTarget && (
        <Modal
          open
          onClose={() => setConfirmBypass(null)}
          title={t('切换到「完全放开」？')}
          closeLabel={t('取消')}
          data-testid="permission-bypass-confirm"
          footer={
            <div className={styles.actions}>
              <Button onClick={() => setConfirmBypass(null)}>{t('取消')}</Button>
              <Button
                variant="danger"
                data-testid="permission-bypass-ok"
                onClick={() => {
                  setConfirmBypass(null);
                  void apply('bypass', bypassTarget);
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
          <p className={styles.target} data-testid="permission-bypass-target">
            {t('标签「{0}」', bypassTarget.title)} · <code>{bypassTarget.cwd}</code>
          </p>
        </Modal>
      )}
    </div>
  );
};
