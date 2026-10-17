import type { MascotScaleState } from '@nomi-ai/types';
import { useEffect, useSyncExternalStore } from 'react';

/**
 * 看板娘大小（渲染进程侧）：真实状态在主进程（MascotWindowController：夹紧到屏幕、窗口随之
 * 调整并保持脚底中心不动、持久化到配置），这里只缓存最近一次状态并转发操作。
 * 滚轮事件会很密：同一帧内的 deltaY 先累加，每帧最多向主进程发一次。
 */
type Listener = () => void;

let state: MascotScaleState | null = null;
let started = false;
let pendingWheel = 0;
let wheelRaf = 0;
const listeners = new Set<Listener>();

const api = () => (typeof window === 'undefined' ? undefined : window.electronAPI?.mascotWindow);

function setState(s: MascotScaleState | null | undefined): void {
  if (!s || typeof s.scale !== 'number') return;
  state = s;
  listeners.forEach((l) => l());
}

function start(): void {
  if (started) return;
  const a = api();
  if (!a?.scaleGet) return;
  started = true;
  void a.scaleGet().then(setState);
  a.onScale?.(setState);
}

function flushWheel(): void {
  wheelRaf = 0;
  const dy = pendingWheel;
  pendingWheel = 0;
  if (dy !== 0) void api()?.scaleWheel(dy, 0).then(setState);
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
    void api()?.scaleStep(dir).then(setState);
  },
  set(scale: number): void {
    void api()?.scaleSet(scale).then(setState);
  },
  reset(): void {
    void api()?.scaleReset().then(setState);
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
 */
export function useMascotZoomInput(): void {
  useEffect(() => {
    if (!api()?.scaleWheel) return undefined;
    start();
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      scaleStore.wheel(e.deltaY, e.deltaMode);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || editable(e.target)) return;
      if (e.key === '=' || e.key === '+') scaleStore.step(1);
      else if (e.key === '-' || e.key === '_') scaleStore.step(-1);
      else if (e.key === '0') scaleStore.reset();
      else return;
      e.preventDefault();
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
    };
  }, []);
}

/** 大小百分比：以原始 420×450 角色框为 100% */
export const scalePercent = (scale: number): number => Math.round(scale * 100);
