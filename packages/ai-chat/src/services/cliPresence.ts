/**
 * 界面只有一种形态：装了 agent（任一内置 CLI）就一直显示 agent 相关的界面（CLI 标签、派出 agent 等），
 * 没装就不显示。不再有「对话 / 工坊」切换。
 * 结果写进 chatPrefs 的模式（normal = 没装，dev = 装了），并记住上次结果，启动时不闪。
 * 装 / 更新完、窗口重新聚焦（可能在终端里装了）时再查一次。
 */
import { isBuiltinCliId } from '@nomi-ai/cli-catalog';

import { setChatMode } from './chatPrefs';
import { cliUpdateClient, isInspectUpdated, type CliInstallInfo } from './cliUpdateClient';
import { harnessClient } from './harnessClient';

/** 窗口重新聚焦时最多这么久查一次 */
const FOCUS_RECHECK_MS = 60_000;

export const anyCliInstalled = (rows: readonly CliInstallInfo[]): boolean =>
  rows.some((r) => isBuiltinCliId(r.kind) && !!r.path);

export const anyHarnessBinPresent = (
  bins: Record<string, string | null> | undefined | null,
): boolean => !!bins && Object.entries(bins).some(([k, v]) => isBuiltinCliId(k) && !!v);

async function check(): Promise<void> {
  try {
    const rows = cliUpdateClient.cached() ?? (await cliUpdateClient.inspect(false));
    if (anyCliInstalled(rows)) {
      setChatMode('dev');
      return;
    }
    if (harnessClient.available()) {
      const st = await harnessClient.state().catch(() => null);
      if (anyHarnessBinPresent(st?.bins)) {
        setChatMode('dev');
        return;
      }
    }
    setChatMode('normal');
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
  const offHarness = harnessClient.available()
    ? harnessClient.onChanged((s) => {
        if (anyHarnessBinPresent(s?.bins)) setChatMode('dev');
        else void check();
      })
    : () => undefined;
  const onFocus = () => {
    if (Date.now() - last < FOCUS_RECHECK_MS) return;
    last = Date.now();
    cliUpdateClient.resetCache();
    void check();
  };
  window.addEventListener('focus', onFocus);
  return () => {
    offEvent();
    offHarness();
    window.removeEventListener('focus', onFocus);
  };
}
