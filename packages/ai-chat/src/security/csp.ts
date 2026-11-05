/**
 * 对话窗口的内容安全策略（构建时由 vite.config.mts 以 meta 标签写进 index.html）。
 *
 * 与 packages/renderer/src/security/csp.ts 的桌面角色 meta CSP 保持一致；两处定义需同步修改。
 *
 * 要点：脚本只允许应用自身文件与 Rive WASM 编译所需的 wasm-unsafe-eval，
 * 不允许 unsafe-inline / unsafe-eval / 远程源，
 * 禁止 object / frame / base / form；LLM 流量一律经内核，故 connect-src
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
  'frame-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
};

export const appCspString = (): string =>
  Object.entries(APP_CSP)
    .map(([k, v]) => `${k} ${v.join(' ')}`)
    .join('; ');
