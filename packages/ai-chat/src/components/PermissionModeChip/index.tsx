/**
 * 输入栏的权限模式按钮（docs/design/cli-permission-modes.md §4）：
 * - 点开下拉选档位；只列当前编程助手支持的档位（不支持的不显示，选了也没意义）；
 * - 输入框里 Shift+Tab 在支持的档位间循环，跳过「完全放开」；
 * - 「完全放开」只能从下拉进入（在下拉里选中即确认，带上当前标签的后端 / 目录供主进程核对）；
 *   之后按钮标红，输入框上方显示提示条（BypassTip），可关掉提示或一键退出；
 * - 下拉底部可以把当前档设为新标签的默认档（「完全放开」不能设为默认）。
 */
import { Icon, t } from '@nomi-ai/ui';
import {
  Check,
  ChevronDown,
  ClipboardList,
  FilePen,
  Hand,
  ShieldAlert,
  Sparkles,
  X,
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
            ? // eslint-disable-next-line nomi/no-cli-literal -- Codex 的 on-request 是自动审批，其它 CLI 的同名值是逐项确认
              backend === 'codex'
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

/** 「完全放开」的目标：选中时的标签身份 */
interface BypassTarget {
  tabId: string;
  backend: HarnessBackend;
  cwd: string;
  title: string;
}

/** 按钮用到的标签字段（Nomi 主标签不在标签列表里，由 harness 状态拼出这几项） */
export type PermissionTab = Pick<
  HarnessTabMeta,
  'id' | 'backend' | 'cwd' | 'title' | 'permissionMode'
>;

export const PermissionModeChip: React.FC<{
  tab: PermissionTab;
  defaultMode?: PermissionMode;
}> = ({ tab, defaultMode }) => {
  const [open, setOpen] = useState(false);
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
            'ui.chat-settings.doesn-t-support-using',
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
    // 在下拉里点「完全放开」就是确认；绑定此刻的标签，主进程再核对后端 / 目录
    if (m === 'bypass')
      void apply('bypass', { tabId: tab.id, backend: tab.backend, cwd: tab.cwd, title: tab.title });
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
        aria-label={t('ui.chat-settings.permission-mode', modeLabel(mode))}
        title={t('ui.chat-settings.shift-tab-to-switch', modeHint(mode, backend))}
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
            aria-label={t('ui.chat-settings.permission-mode-label')}
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
                  <span className={styles.itemHint}>{modeHint(m, backend)}</span>
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
                <kbd className={styles.kbd}>Shift+Tab</kbd>{' '}
                {t('ui.chat-settings.to-switch-in-the-input-box')}
              </span>
              {/* 「新标签默认」只对编程助手标签有意义：Nomi 只有一个主对话 */}
              {backend !== 'nomi' && mode !== 'bypass' && mode !== defaultMode && (
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
                        setNote({
                          tabId,
                          text: t('ui.chat-settings.new-tabs-now-default-to', modeLabel(mode)),
                        }),
                      )
                      .catch(() => undefined);
                  }}
                >
                  {t('ui.chat-settings.make-default-for-new-tabs')}
                </button>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
};

/**
 * 「完全放开」期间输入框上方的提示条：说明风险，可以只关掉提示，或直接退回 exitMode。
 * 关掉的提示只对这个标签的这一次「完全放开」有效：退出后再进入会重新显示。
 */
export const BypassTip: React.FC<{ tab: HarnessTabMeta; exitMode: PermissionMode }> = ({
  tab,
  exitMode,
}) => {
  /** 关掉提示的标签：离开完全放开后移除，再次进入时重新显示 */
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const [err, setErr] = useState<string | null>(null);
  const bypass = tab.permissionMode === 'bypass';
  if (!bypass && dismissed.has(tab.id))
    setDismissed((d) => new Set([...d].filter((x) => x !== tab.id)));
  if (!bypass && err) setErr(null);
  if (!bypass || dismissed.has(tab.id)) return null;
  const name = tab.backend === 'nomi' ? '' : ENDPOINT_NAME[tab.backend];
  return (
    <div className={styles.tip} role="status" data-testid="permission-bypass-tip">
      <Icon icon={ShieldAlert} size={14} />
      <span className={styles.tipText}>
        {err ?? t('ui.chat-settings.full-access-won-t-ask-and-can-change', name)}
      </span>
      <button
        type="button"
        className={styles.tipAction}
        data-testid="permission-bypass-exit"
        onClick={() => {
          setErr(null);
          void harnessClient
            .setTabPermissionMode(tab.id, exitMode, { confirmed: false })
            .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
        }}
      >
        {t('ui.chat-settings.exit-full-access')}
      </button>
      <button
        type="button"
        className={styles.tipClose}
        aria-label={t('ui.mascot-theme.dismiss')}
        title={t('ui.mascot-theme.dismiss')}
        data-testid="permission-bypass-tip-close"
        onClick={() => setDismissed((d) => new Set(d).add(tab.id))}
      >
        <Icon icon={X} size={12} />
      </button>
    </div>
  );
};
