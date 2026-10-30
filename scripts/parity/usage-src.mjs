/**
 * usage 录制器公共加载：从 TS 源码用 esbuild 去类型后以 data: URL 加载（不依赖任何 dist）。
 * 相对 import 按 map 重写为已加载模块的 data URL；没给的相对 import 报错。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { transformSync } = await import('esbuild');
const toUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

/** rel：相对 apps/desktop-electron/internal/core/src 的路径（不带 .ts）；deps：import 说明符 → data URL */
export async function loadSrc(rel, deps = {}) {
  const src = readFileSync(
    join(root, 'apps/desktop-electron/internal/core/src', `${rel}.ts`),
    'utf8',
  );
  let { code } = transformSync(src, { loader: 'ts', format: 'esm' });
  code = code.replace(/from\s+"([^"]+)"/g, (m, spec) => {
    if (spec in deps) return `from "${deps[spec]}"`;
    if (spec.startsWith('.')) throw new Error(`${rel}: unmapped import ${spec}`);
    return m;
  });
  const url = toUrl(code);
  return { url, mod: await import(url) };
}

export const jsModule = (code) => toUrl(code);
