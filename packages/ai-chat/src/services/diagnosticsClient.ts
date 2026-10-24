/**
 * 诊断日志（docs/design/cli-plugin-architecture.md §8）：window.electronAPI.diagnostics 的薄封装。
 * 浏览器预览等没有桥的环境 available() 为 false，界面不显示这一组。
 */
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

interface DiagnosticsApi {
  get: () => Promise<DiagnosticsView>;
  set: (on: boolean) => Promise<DiagnosticsView>;
  openFolder: () => Promise<boolean>;
  export: () => Promise<DiagnosticsExportResult>;
}

const api = (): DiagnosticsApi | null =>
  (window as unknown as { electronAPI?: { diagnostics?: DiagnosticsApi } }).electronAPI
    ?.diagnostics ?? null;

const need = (): DiagnosticsApi => {
  const a = api();
  if (!a) throw new Error('diagnostics bridge unavailable');
  return a;
};

export const diagnosticsClient = {
  available: () => !!api(),
  get: () => need().get(),
  set: (on: boolean) => need().set(on),
  openFolder: () => need().openFolder(),
  exportBundle: () => need().export(),
};
