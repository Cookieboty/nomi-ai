/**
 * 应用内确认 / 输入框：替代 window.confirm / window.prompt。系统弹窗在 macOS / Windows 上样式各不相同、
 * 按钮文案跟随系统语言，这里统一用 @nomi-ai/ui 的 Modal + Button，跟应用主题与界面语言走。
 *
 * 用法：
 *   if (!(await confirmDialog({ message, danger: true }))) return;
 *   const name = await promptDialog({ title, defaultValue }); // 取消 → null
 * 宿主在第一次调用时挂到 document.body 上（独立 React root），调用方不需要在树里放组件。
 * 从别的 Modal 里弹出也没问题：焦点陷阱 / Esc 按 useFocusTrap 的栈只作用于最上层。
 */
import { Button, Input, Modal, t } from '@nomi-ai/ui';
import React, { useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import styles from './index.module.css';

export interface ConfirmOptions {
  /** 标题（默认「请确认」）；一句话的确认可以只给 message */
  title?: string;
  message?: React.ReactNode;
  /** 确认按钮文字（默认「确定」） */
  confirmLabel?: string;
  /** 危险操作：确认按钮用 danger 样式，默认焦点落在「取消」 */
  danger?: boolean;
}

export interface PromptOptions extends Omit<ConfirmOptions, 'danger'> {
  title: string;
  defaultValue?: string;
  /** 输入框的无障碍名称（默认用标题） */
  label?: string;
}

type Pending =
  | (ConfirmOptions & { kind: 'confirm'; resolve: (ok: boolean) => void })
  | (PromptOptions & { kind: 'prompt'; resolve: (v: string | null) => void });

let root: Root | null = null;
let show: ((p: Pending) => void) | null = null;
const queue: Pending[] = [];

const cancelOf = (p: Pending) => (p.kind === 'confirm' ? p.resolve(false) : p.resolve(null));

const ConfirmHost: React.FC = () => {
  const [cur, setCur] = useState<Pending | null>(null);
  const [value, setValue] = useState('');
  useEffect(() => {
    show = (p) => setCur((c) => (c ? (queue.push(p), c) : p));
    for (const p of queue.splice(0)) show(p);
    return () => {
      show = null;
    };
  }, []);
  useEffect(() => {
    if (cur?.kind === 'prompt') setValue(cur.defaultValue ?? '');
  }, [cur]);
  if (!cur) return null;
  const next = () => setCur(queue.shift() ?? null); // 同时排队的下一条接着显示
  const cancel = () => {
    cancelOf(cur);
    next();
  };
  const ok = () => {
    if (cur.kind === 'confirm') cur.resolve(true);
    else cur.resolve(value);
    next();
  };
  const danger = cur.kind === 'confirm' && cur.danger;
  return (
    <Modal
      open
      onClose={cancel}
      title={cur.title ?? t('ui.foundation.please-confirm')}
      className={styles.dialog}
      data-testid="confirm-dialog"
      footer={
        <>
          <Button
            onClick={cancel}
            data-testid="confirm-dialog-cancel"
            {...(danger ? { 'data-autofocus': '' } : {})}
          >
            {t('ui.foundation.cancel')}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={ok}
            data-testid="confirm-dialog-ok"
            {...(!danger && cur.kind === 'confirm' ? { 'data-autofocus': '' } : {})}
          >
            {cur.confirmLabel ?? t('ui.foundation.ok')}
          </Button>
        </>
      }
    >
      {cur.message != null && <div className={styles.message}>{cur.message}</div>}
      {cur.kind === 'prompt' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            ok();
          }}
        >
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label={cur.label ?? cur.title}
            data-testid="confirm-dialog-input"
            data-autofocus=""
          />
        </form>
      )}
    </Modal>
  );
};

function enqueue(p: Pending): void {
  if (show) {
    show(p);
    return;
  }
  queue.push(p);
  if (!root) {
    const el = document.createElement('div');
    el.dataset.confirmHost = '';
    document.body.appendChild(el);
    root = createRoot(el);
    root.render(<ConfirmHost />);
  }
}

/** 弹出应用内确认框；确认 → true，取消 / Esc / 点遮罩 → false */
export function confirmDialog(o: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => enqueue({ ...o, kind: 'confirm', resolve }));
}

/** 弹出应用内输入框；确认 → 输入的文字（原样，调用方自己 trim），取消 → null */
export function promptDialog(o: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => enqueue({ ...o, kind: 'prompt', resolve }));
}

/** 测试用：卸载宿主，清掉排队中的请求（按取消处理） */
export function resetConfirmDialogForTest(): void {
  for (const p of queue.splice(0)) cancelOf(p);
  root?.unmount();
  root = null;
  show = null;
  document.querySelectorAll('[data-confirm-host]').forEach((el) => el.remove());
}
