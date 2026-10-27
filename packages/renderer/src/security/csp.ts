/**
 * 看板娘窗口的内容安全策略（CSP）。构建时以 <meta> 注入 index.html；
 * 开发模式（Vite HMR 需要内联脚本）不注入。tests/security/csp.test.ts 与 e2e E11 校验它。
 *
 * 要点：脚本只允许应用自身文件与 Rive WASM 编译所需的 wasm-unsafe-eval，
 * 不允许 unsafe-inline / unsafe-eval / 远程源，
 * 禁止 object / frame / base 劫持；TTS 音频可能来自 blob: 或本地 / 远程服务。
 */
export const MASCOT_CSP: Record<string, string[]> = {
  'default-src': ["'self'"],
  'script-src': ["'self'", "'wasm-unsafe-eval'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'blob:', 'character-pack:'],
  'font-src': ["'self'", 'data:'],
  'connect-src': ["'self'", 'blob:', 'data:', 'character-pack:'],
  'media-src': ["'self'", 'blob:', 'data:', 'character-pack:', 'http:', 'https:'],
  'worker-src': ["'self'", 'blob:'],
  'object-src': ["'none'"],
  'frame-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
};

export const mascotCspString = (): string =>
  Object.entries(MASCOT_CSP)
    .map(([k, v]) => `${k} ${v.join(' ')}`)
    .join('; ');
