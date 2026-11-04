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

/** 编程助手子进程的一条原始收发（logs/cli-*.jsonl 的一行） */
export interface CliRecord {
  /** ISO 时间 */
  t: string;
  /** spawn / in / out / err / exit */
  ev?: string;
  pid?: number;
  cli?: string;
  data?: string;
  args?: string[];
  code?: number | null;
  signal?: string | null;
  note?: string;
}

export interface CliRecordsResult {
  enabled: boolean;
  records: CliRecord[];
  truncated: boolean;
}

export interface GatewayTraceResult {
  found: boolean;
  text?: string;
  truncated?: boolean;
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
  /** 开发者工具：某个标签在 [from, to] 里的子进程原始收发 */
  cliRecords: (q: { tabId: string; from: number; to: number }): Promise<CliRecordsResult> =>
    need().cliRecords(q),
  /** 开发者工具：按追踪 id 取网关请求 / 响应正文 */
  gatewayTrace: (traceId: string): Promise<GatewayTraceResult> => need().gatewayTrace({ traceId }),
};
