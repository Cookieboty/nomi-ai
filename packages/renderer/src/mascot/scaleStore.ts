import type { MascotScaleState } from '@nomi-ai/types';
import { useEffect, useSyncExternalStore } from 'react';

import { api, hasTransport } from '../services/api';

/**
 * Nomi 大小（渲染进程侧）：真实状态在主进程（MascotWindowController：夹紧到屏幕、窗口随之
 * 调整并保持脚底中心不动、持久化到配置），这里只缓存最近一次状态并转发操作。
 * 滚轮事件会很密：同一帧内的 deltaY 先累加，每帧最多向主进程发一次。
 */
type Listener = () => void;

let state: MascotScaleState | null = null;
let started = false;
let pendingWheel = 0;
let wheelRaf = 0;
const listeners = new Set<Listener>();

/** 主进程不可用（浏览器预览 / 测试）或调用失败：保持上一次状态 */
const ignore = (): undefined => undefined;

function setState(s: MascotScaleState | null | undefined): void {
  if (!s || typeof s.scale !== 'number') return;
  state = s;
  listeners.forEach((l) => l());
}

function start(): void {
  if (started) return;
  if (!hasTransport()) return;
  started = true;
  void api.mascot.scaleGet().then(setState, ignore);
  api.on('mascot.scaleChanged', setState);
}

function flushWheel(): void {
  wheelRaf = 0;
  const dy = pendingWheel;
  pendingWheel = 0;
  if (dy !== 0 && hasTransport())
    void api.mascot.scaleWheel({ deltaY: dy, deltaMode: 0 }).then(setState, ignore);
}

export const scaleStore = {
  get: (): MascotScaleState | null => state,
  subscribe(l: Listener): () => void {
    start();
    listeners.add(l);
    return () => listeners.delete(l);
  },
  /** Ctrl/⌘ + 滚轮（deltaY 向上滚为负 = 放大） */
  wheel(deltaY: number, deltaMode = 0): void {
    if (!Number.isFinite(deltaY) || deltaY === 0) return;
    const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 100 : deltaY;
    pendingWheel += Math.max(-300, Math.min(300, px));
    if (!wheelRaf) wheelRaf = requestAnimationFrame(flushWheel);
  },
  step(dir: 1 | -1): void {
    if (hasTransport()) void api.mascot.scaleStep({ dir }).then(setState, ignore);
  },
  set(scale: number): void {
    if (hasTransport()) void api.mascot.scaleSet({ scale }).then(setState, ignore);
  },
  reset(): void {
    if (hasTransport()) void api.mascot.scaleReset().then(setState, ignore);
  },
};

/** 当前大小状态（主进程不可用 / 浏览器预览时为 null） */
export function useMascotScale(): MascotScaleState | null {
  return useSyncExternalStore(scaleStore.subscribe, scaleStore.get, () => null);
}

const editable = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
};

/**
 * 缩放输入：Ctrl/⌘ + 滚轮（含触控板捏合），Ctrl/⌘ + 加号 / 减号 / 0。
 * 只会在窗口真正收到事件时触发：透明区域点击穿透，事件落到下面的窗口，不会误缩放。
 * 真实 Electron 运行时还有主进程 before-input-event 兜底（见 MascotWindowController）：
 * Chromium 在部分键盘布局下会把 Ctrl+Shift+= 当作内置 zoomIn 吃掉，preventDefault 后
 * renderer 这里不会二次收到；本层仍然保留，用于浏览器预览 / 测试等无主进程兜底的场景。
 */
export function useMascotZoomInput(): void {
  useEffect(() => {
    if (!hasTransport()) return undefined;
    start();
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      scaleStore.wheel(e.deltaY, e.deltaMode);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || editable(e.target)) return;
      const { code, key } = e;
      let action: 1 | -1 | 'reset';
      if (code === 'Equal' || code === 'NumpadAdd' || key === '=' || key === '+') action = 1;
      else if (code === 'Minus' || code === 'NumpadSubtract' || key === '-' || key === '_')
        action = -1;
      else if (code === 'Digit0' || code === 'Numpad0' || key === '0') action = 'reset';
      else return;
      e.preventDefault();
      if (action === 'reset') scaleStore.reset();
      else scaleStore.step(action);
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    // capture 阶段：抢在业务组件之前拿到键盘事件，避免被 stopPropagation 吞掉
    window.addEventListener('keydown', onKey, { capture: true });
    return () => {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey, { capture: true });
    };
  }, []);
}

/** 大小百分比：以原始 420×450 角色框为 100% */
export const scalePercent = (scale: number): number => Math.round(scale * 100);
