/**
 * 「更新后显示更新日志」偏好 + 已确认版本号。
 * localStorage（与 chatPrefs 同层）；取消勾选后持久化，之后升级重启不再自动弹出；
 * 设置里可重新打开偏好，或点「查看更新日志」随时打开弹层。
 */
type Listener = () => void;

const SHOW_KEY = 'ai-chat:releaseNotes:showAfterUpdate';
const ACK_KEY = 'ai-chat:releaseNotes:ackedVersion';

const showSubs = new Set<Listener>();
const openSubs = new Set<Listener>();

function storage(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** 默认开启：升级重启后自动展示更新说明 */
export function getShowReleaseNotesAfterUpdate(): boolean {
  const s = storage();
  if (!s) return true;
  const v = s.getItem(SHOW_KEY);
  if (v === null) return true;
  return v !== '0';
}

export function setShowReleaseNotesAfterUpdate(on: boolean): void {
  const s = storage();
  if (s) {
    try {
      s.setItem(SHOW_KEY, on ? '1' : '0');
    } catch {
      /* ignore */
    }
  }
  showSubs.forEach((fn) => fn());
}

export function subscribeShowReleaseNotesAfterUpdate(fn: Listener): () => void {
  showSubs.add(fn);
  return () => void showSubs.delete(fn);
}

/** 用户已看过（或静默跳过）的版本；null = 从未记录（首次启动） */
export function getAckedReleaseNotesVersion(): string | null {
  const s = storage();
  if (!s) return null;
  return s.getItem(ACK_KEY);
}

export function acknowledgeReleaseNotesVersion(version: string): void {
  const s = storage();
  if (!s || !version) return;
  try {
    s.setItem(ACK_KEY, version);
  } catch {
    /* ignore */
  }
}

/** 设置 / 其它入口请求立刻打开更新说明弹层 */
export function openReleaseNotes(): void {
  openSubs.forEach((fn) => fn());
}

export function onOpenReleaseNotes(fn: Listener): () => void {
  openSubs.add(fn);
  return () => void openSubs.delete(fn);
}
