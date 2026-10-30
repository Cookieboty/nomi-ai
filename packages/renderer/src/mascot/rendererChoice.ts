/**
 * 看板娘渲染器选择（docs/design/migrate-2.0.5-go.md §0、Q5：默认静态 SVG，Rive 由用户在设置里开启）。
 * 设置存在内核的 `mascot.renderer`（Node 与 Go 内核相同），切换时内核广播 `mascot.rendererChanged`。
 *
 * - 有契约传输（Electron / Go 宿主）：按设置；`svg` 时内置角色改用静态立绘（avatar-runtime 的 static 模式），
 *   Rive 包与 wasm 不加载；覆盖包（Scheme B）按自己的 manifest 渲染；
 * - 没有传输（浏览器预览 / 测试）：Rive。
 */
import { useEffect, useState } from 'react';

import { api, hasTransport } from '../services/api';

export type MascotRenderer = 'svg' | 'rive';

const asRenderer = (v: unknown): MascotRenderer => (v === 'rive' ? 'rive' : 'svg');

/** 当前渲染器；读到设置之前为 null（先不挂角色，免得先画 Rive 再换） */
export function useMascotRenderer(): MascotRenderer | null {
  const [renderer, setRenderer] = useState<MascotRenderer | null>(() =>
    hasTransport() ? null : 'rive',
  );
  useEffect(() => {
    if (!hasTransport()) return;
    let alive = true;
    const off = api.on('mascot.rendererChanged', (r) => setRenderer(asRenderer(r)));
    api.mascot
      .getRenderer()
      .then((r) => alive && setRenderer((cur) => cur ?? asRenderer(r)))
      .catch(() => alive && setRenderer((cur) => cur ?? 'svg'));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return renderer;
}

let staticArt: Promise<string> | null = null;

/** 内置角色的静态立绘地址（约 4 MB 的 SVG，独立资源，只在选了静态时才请求） */
export function loadStaticArtUrl(): Promise<string> {
  staticArt ??= import('./staticArt').then((m) => m.default);
  return staticArt;
}
