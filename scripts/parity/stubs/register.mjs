import Module, { register } from 'node:module';
import { fileURLToPath } from 'node:url';
register('./electron-hooks.mjs', import.meta.url);
// tsx 可能把 TS 编成 CJS：同时拦截 require('electron')
const stub = fileURLToPath(new URL('./electron.cjs', import.meta.url));
const coreSrc = fileURLToPath(
  new URL('../../../apps/desktop-electron/internal/core/src/', import.meta.url),
);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'electron') return stub;
  // 源码直跑：@nomi-ai/core/x → apps/desktop-electron/internal/core/src/x.ts（不依赖 dist 构建）
  if (req.startsWith('@nomi-ai/core/')) {
    const sub = req.slice('@nomi-ai/core/'.length);
    for (const c of [`${coreSrc}${sub}.ts`, `${coreSrc}${sub}/index.ts`]) {
      try {
        return orig.call(this, c, ...rest);
      } catch {
        /* ignore */
      }
    }
  }
  return orig.call(this, req, ...rest);
};
