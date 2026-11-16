/**
 * 对话窗口的内容安全策略（构建时由 vite.config.mts 以 meta 标签写进 index.html）。
 *
 * 除 frame-src 外与 packages/renderer/src/security/csp.ts 的桌面角色 meta CSP 保持一致：
 * 对话窗口标签区内置浏览器（BrowserTab）需以沙箱 iframe 加载外部 http(s) 网页，故 frame-src
 * 仅放行 http: 与 https:（仍禁止 file: / data: / blob: / 'self'）；桌面角色窗口保持 'none'。
 *
 * 要点：脚本只允许应用自身文件与 Rive WASM 编译所需的 wasm-unsafe-eval，
 * 不允许 unsafe-inline / unsafe-eval / 远程源，
 * 禁止 object / base / form；LLM 流量一律经内核，故 connect-src
 * 不开放 http(s)；媒体允许远程 TTS 音频（遗留 TTS / 用户自配服务）。
 */
export const APP_CSP: Record<string, string[]> = {
  'default-src': ["'self'"],
  'script-src': ["'self'", "'wasm-unsafe-eval'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'blob:', 'chat-asset:', 'character-pack:', 'https:'],
  'font-src': ["'self'", 'data:'],
  'connect-src': ["'self'", 'chat-asset:', 'character-pack:', 'blob:', 'data:'],
  'media-src': ["'self'", 'blob:', 'data:', 'character-pack:', 'http:', 'https:'],
  'worker-src': ["'self'", 'blob:'],
  'object-src': ["'none'"],
  'frame-src': ['http:', 'https:'],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
};

export const appCspString = (): string =>
  Object.entries(APP_CSP)
    .map(([k, v]) => `${k} ${v.join(' ')}`)
    .join('; ');
