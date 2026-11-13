/**
 * 界面只有一种形态：装了编程助手（任一内置 CLI）就一直显示编程助手相关的界面（CLI 标签、派出编程助手等），
 * 没装就不显示。不再有「对话 / 工坊」切换。
 * 结果写进 chatPrefs 的模式（normal = 没装，dev = 装了），并记住上次结果，启动时不闪。
 * 装 / 更新完、窗口重新聚焦（可能在终端里装了）时再查一次。
 */
import { isBuiltinCliId } from '@nomi-ai/cli-catalog';

import { setChatMode } from './chatPrefs';
import { cliUpdateClient, isInspectUpdated, type CliInstallInfo } from './cliUpdateClient';

/** 窗口重新聚焦时最多这么久查一次 */
const FOCUS_RECHECK_MS = 60_000;

export const anyCliInstalled = (rows: readonly CliInstallInfo[]): boolean =>
  rows.some((r) => isBuiltinCliId(r.kind) && !!r.path);

async function check(): Promise<void> {
  try {
    const rows = cliUpdateClient.cached() ?? (await cliUpdateClient.inspect(false));
    setChatMode(anyCliInstalled(rows) ? 'dev' : 'normal');
  } catch {
    /* 查不到就保持上次的结果 */
  }
}

/** App 启动时调用一次；返回停止监听的函数 */
export function watchCliPresence(): () => void {
  if (!cliUpdateClient.available()) return () => undefined;
  void check();
  let last = Date.now();
  const offEvent = cliUpdateClient.onEvent((e) => {
    if (isInspectUpdated(e)) {
      void check();
      return;
    }
    if (e.phase !== 'done') return;
    cliUpdateClient.resetCache();
    void check();
  });
  const onFocus = () => {
    if (Date.now() - last < FOCUS_RECHECK_MS) return;
    last = Date.now();
    cliUpdateClient.resetCache();
    void check();
  };
  window.addEventListener('focus', onFocus);
  return () => {
    offEvent();
    window.removeEventListener('focus', onFocus);
  };
}
