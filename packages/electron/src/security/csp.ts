/**
 * 业务窗口统一内容安全策略（由主进程通过 onHeadersReceived 以响应头注入）。
 *
 * 与 packages/renderer/src/security/csp.ts 的看板娘 meta CSP 保持一致；两处定义
 * 需同步修改（renderer 侧有单测与 e2e 校验，本侧在生产以响应头覆盖全部窗口）。
 *
 * 要点：脚本只允许应用自身文件（无 'unsafe-inline' / 'unsafe-eval' / 远程源），
 * 禁止 object / frame / base / form；LLM 流量一律走主进程 IPC，故 connect-src
 * 不开放 http(s)；媒体允许远程 TTS 音频（遗留 TTS / 用户自配服务）。
 */
export const APP_CSP: Record<string, string[]> = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'blob:', 'cdmodel:', 'chat-asset:', 'https:'],
  'font-src': ["'self'", 'data:'],
  'connect-src': ["'self'", 'cdmodel:', 'chat-asset:', 'blob:', 'data:'],
  'media-src': ["'self'", 'blob:', 'data:', 'cdmodel:', 'http:', 'https:'],
  'worker-src': ["'self'", 'blob:'],
  'object-src': ["'none'"],
  'frame-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
};

export const appCspString = (): string =>
  Object.entries(APP_CSP)
    .map(([k, v]) => `${k} ${v.join(' ')}`)
    .join('; ');
