/**
 * 桌面角色渲染器选择（docs/design/migrate-2.0.5-go.md §0、Q5：默认静态 SVG，Rive 由用户在设置里开启）。
 * 设置存在内核的 `mascot.renderer`（Node 与 Go 内核相同），切换时内核广播 `mascot.rendererChanged`。
 *
 * - 有契约传输（Electron / Go 宿主）：按设置；`svg` 时内置包改用它自己的静态立绘（avatar-runtime 的 static
 *   模式，见 loadStaticArtUrl），Rive 包与 wasm 不加载；包没有静态立绘时按包自己的模式；覆盖包（Scheme B）
 *   按自己的 manifest 渲染；
 * - 没有传输（浏览器预览 / 测试）：Rive。
 */
import { useEffect, useState } from 'react';

import { api, hasTransport, hostAssetUrl } from '../services/api';

import { BUNDLED_PACK } from './characterConfig';

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

/**
 * 内置包的 .riv 是远程素材（manifest `assets.remote`）：不随安装包发，切到 Rive 时由内核下载
 * （docs/design/remote-character-assets.md）。
 */
export function bundledRiveIsRemote(): boolean {
  return BUNDLED_PACK.assets.remote?.includes('rive') ?? false;
}

/**
 * 内核下载好的远程 .riv 地址（character-pack://assets/…，Go 宿主上换成本地地址）；还没就绪 / 下载失败 /
 * 不需要时为 null，调用方先显示静态立绘。内核更新到新版本时地址会变，角色随之重新加载。
 */
export function useRemoteRiveUrl(wanted: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!wanted || !hasTransport()) return;
    let alive = true;
    const apply = (s: { remote: boolean; status: string; riveUrl?: string | null }) => {
      if (!alive) return;
      setUrl(s.remote && s.status === 'ready' && s.riveUrl ? hostAssetUrl(s.riveUrl) : null);
    };
    const off = api.on('character.assetsChanged', apply);
    api.character.assets().then(apply, () => undefined);
    return () => {
      alive = false;
      off();
    };
  }, [wanted]);
  return wanted ? url : null;
}

let staticArt: Promise<string | null> | null = null;

/**
 * 内置包（构建时选中的包）的静态立绘地址：静态包是它自己的立绘，官方包是它的 SVG 立绘（约 4 MB，独立资源，
 * 只在选了静态时才请求）；包没有静态立绘时为 null，调用方按包自己的模式渲染。不会给出别的包的立绘。
 */
export function loadStaticArtUrl(): Promise<string | null> {
  staticArt ??= import('./staticArt').then((m) => m.default);
  return staticArt;
}
