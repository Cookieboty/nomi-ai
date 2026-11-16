import type { KeyboardEvent } from 'react';

import type { AgentOption } from '../../slash/agentComplete';
import type { AtPathOption } from '../../slash/atPathComplete';
import type { ModelArgOption, SlashCommand } from '../../slash/types';
import { isImeComposing, moveTextareaToLineBoundary } from '../../utils/keyboard';
import { CYCLE_PERMISSION_EVENT, type CyclePermissionDetail } from '../../utils/permissionModes';

interface KeyboardHandlerContext {
  composingRef: React.RefObject<boolean>;
  agentOpen: boolean;
  agentOptions: AgentOption[];
  agentIdx: number;
  agentQuery: string | null;
  setAgentIdx: (idx: number | ((prev: number) => number)) => void;
  setAgentClosed: (msg: string) => void;
  pickAgent: (o: AgentOption) => void;
  modelOpen: boolean;
  modelOptions: ModelArgOption[];
  modelIdx: number;
  modelQuery: string | null;
  setModelIdx: (idx: number | ((prev: number) => number)) => void;
  setModelClosed: (msg: string) => void;
  pickModelArg: (o: ModelArgOption) => void;
  slashOpen: boolean;
  slashFlat: Array<{ command: SlashCommand }>;
  slashIdx: number;
  setSlashIdx: (idx: number | ((prev: number) => number)) => void;
  pickCommand: (c: SlashCommand, mode: 'run' | 'complete') => void;
  setMessage: (msg: string) => void;
  atOpen: boolean;
  atOptions: AtPathOption[];
  atIdx: number;
  setAtIdx: (idx: number | ((prev: number) => number)) => void;
  setAtClosed: (msg: string) => void;
  pickAtPath: (o: AtPathOption) => void;
  message: string;
  busy: boolean;
  queue?: { onFlush?: () => void; pending?: number };
  handleSend: (mode?: 'steer' | 'queue') => void | Promise<void>;
  /** 按键时再读最新的消息（渲染期的快照可能还没有刚发出的那条） */
  getChatMessages: () => ReadonlyArray<{ role: string; content: string }>;
  newlineCaret: React.MutableRefObject<number | null>;
}

export function createKeyDownHandler(ctx: KeyboardHandlerContext) {
  return (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (ctx.composingRef.current || isImeComposing(e.nativeEvent)) return;

    // Alt+Enter: 换行
    if (e.key === 'Enter' && e.altKey) {
      e.preventDefault();
      const el = e.currentTarget;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      ctx.newlineCaret.current = start + 1;
      ctx.setMessage(`${el.value.slice(0, start)}\n${el.value.slice(end)}`);
      return;
    }

    // Shift+Enter: 原生换行
    if (e.key === 'Enter' && e.shiftKey) return;

    // Home/End: 行边界
    if ((e.key === 'Home' || e.key === 'End') && !e.altKey) {
      e.preventDefault();
      moveTextareaToLineBoundary(e.currentTarget, e.key, e.shiftKey, e.ctrlKey || e.metaKey);
      return;
    }

    // Agent 补全
    if (ctx.agentOpen) {
      const n = ctx.agentOptions.length;
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && n) {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        ctx.setAgentIdx((i) => (i + d + n) % n);
        return;
      }
      const o = ctx.agentOptions[Math.min(ctx.agentIdx, n - 1)];
      const typed = (ctx.agentQuery ?? '').toLowerCase();
      const exact = !!typed && ctx.agentOptions.some((x) => x.id === typed);
      if ((e.key === 'Enter' && !e.shiftKey && !exact) || (e.key === 'Tab' && !e.shiftKey)) {
        if (o?.installed) {
          e.preventDefault();
          ctx.pickAgent(o);
          return;
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        ctx.setAgentClosed(ctx.message);
        return;
      }
    }

    // Model 补全
    if (ctx.modelOpen) {
      const n = ctx.modelOptions.length;
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && n) {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        ctx.setModelIdx((i) => (i + d + n) % n);
        return;
      }
      const o = ctx.modelOptions[Math.min(ctx.modelIdx, n - 1)];
      const typed = (ctx.modelQuery ?? '').toLowerCase();
      const exact = !!typed && ctx.modelOptions.some((x) => x.value.toLowerCase() === typed);
      if (o && ((e.key === 'Enter' && !e.shiftKey && !exact) || (e.key === 'Tab' && !e.shiftKey))) {
        e.preventDefault();
        ctx.pickModelArg(o);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        ctx.setModelClosed(ctx.message);
        return;
      }
    }

    // 斜杠命令补全
    if (ctx.slashOpen) {
      const n = ctx.slashFlat.length;
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && n) {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        ctx.setSlashIdx((i) => (i + d + n) % n);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const c = ctx.slashFlat[Math.min(ctx.slashIdx, n - 1)]?.command;
        if (c) ctx.pickCommand(c, e.key === 'Tab' ? 'complete' : 'run');
        else if (e.key === 'Enter') void ctx.handleSend();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        ctx.setMessage('');
        return;
      }
    }

    // @ 路径补全
    if (ctx.atOpen) {
      const n = ctx.atOptions.length;
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && n) {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        ctx.setAtIdx((i) => (i + d + n) % n);
        return;
      }
      const o = n ? ctx.atOptions[Math.min(ctx.atIdx, n - 1)] : undefined;
      if (o && ((e.key === 'Enter' && !e.shiftKey) || (e.key === 'Tab' && !e.shiftKey))) {
        e.preventDefault();
        ctx.pickAtPath(o);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        ctx.setAtClosed(ctx.message);
        return;
      }
    }

    // Shift+Tab: 切换权限模式
    if (e.key === 'Tab' && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const detail: CyclePermissionDetail = { handled: false };
      window.dispatchEvent(new CustomEvent(CYCLE_PERMISSION_EVENT, { detail }));
      if (detail.handled) e.preventDefault();
      return;
    }

    // ↑ 空输入框找回上一条
    if (e.key === 'ArrowUp' && !ctx.message) {
      const last = [...ctx.getChatMessages()].reverse().find((m) => m.role === 'user');
      if (last) {
        e.preventDefault();
        ctx.setMessage(last.content);
      }
      return;
    }

    // Ctrl/⌘+Enter 发送
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      void ctx.handleSend('queue');
      return;
    }

    // Esc: 停止并发送排队消息
    if (e.key === 'Escape' && ctx.busy && ctx.queue?.onFlush && (ctx.queue.pending ?? 0) > 0) {
      e.preventDefault();
      ctx.queue.onFlush();
      return;
    }

    // Enter 发送
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      ctx.handleSend();
      return;
    }
  };
}
