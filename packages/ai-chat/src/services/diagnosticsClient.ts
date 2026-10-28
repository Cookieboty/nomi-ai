/**
 * 诊断日志（docs/design/cli-plugin-architecture.md §8）：应用契约 `diagnostics.*` 的薄封装（只在对话窗口）。
 * 浏览器预览等没有契约传输的环境 available() 为 false，界面不显示这一组。
 */
import { api, hasTransport } from './api';

export interface DiagnosticsView {
  /** 现在是否在记录 */
  enabled: boolean;
  /** 开发版必开（界面上不能关） */
  forced: boolean;
  /** 用户的选择（正式版） */
  saveLogs: boolean;
  /** 日志目录 */
  dir: string;
  /** 网关正文追踪是否在记 */
  bodyTrace: boolean;
}

export interface DiagnosticsExportResult {
  ok: boolean;
  path?: string;
  files?: string[];
  error?: string;
}

const need = (): typeof api.diagnostics => {
  if (!hasTransport()) throw new Error('diagnostics bridge unavailable');
  return api.diagnostics;
};

export const diagnosticsClient = {
  available: () => hasTransport(),
  get: (): Promise<DiagnosticsView> => need().get(),
  set: (on: boolean): Promise<DiagnosticsView> => need().set({ on }),
  openFolder: (): Promise<boolean> => need().openFolder(),
  exportBundle: (): Promise<DiagnosticsExportResult> => need().export(),
};
