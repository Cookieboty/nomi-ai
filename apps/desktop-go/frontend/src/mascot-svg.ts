/**
 * 看板娘（默认 SVG 版）：只用 <img> 显示一张静态 SVG 立绘，不加载 Rive / wasm，无任何动画。
 *
 * 布局与 2.0.4 Electron 的 RiveCanvas 一致（1:1）：立绘只画在 characterBox 内
 * （窗口去掉左右 60px、顶部 130px 的透明边距，留给工具栏 / 气泡），
 * 并按 Fit.Contain + Alignment.BottomCenter 放置。之前铺满整个 330×355 窗口，导致看板娘偏大。
 */
import { characterBox } from '../../../../packages/avatar-runtime/src/spriteLayout';
import svgUrl from '../../../../rive/nomi-complete/reference/svg-rig/nomi-fullbody-mother.svg?url';

/** 挂到 app 上；返回卸载函数 */
export function mount(app: HTMLElement, mark: (n: string) => void): () => void {
  const img = document.createElement('img');
  img.alt = 'Nomi';
  img.draggable = false;
  img.style.cssText =
    'position:absolute;object-fit:contain;object-position:50% 100%;display:block;background:transparent;';
  const place = () => {
    const b = characterBox(app.clientWidth, app.clientHeight);
    Object.assign(img.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` });
  };
  place();
  const ro = new ResizeObserver(place);
  ro.observe(app);
  img.onload = () => mark('svg-loaded');
  img.src = svgUrl;
  app.appendChild(img);
  return () => {
    ro.disconnect();
    img.remove();
  };
}
