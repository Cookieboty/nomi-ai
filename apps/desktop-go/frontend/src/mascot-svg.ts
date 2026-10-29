/** 看板娘（默认 SVG 版）：只用 <img> 显示一张静态 SVG 立绘，不加载 Rive / wasm，无任何动画。 */
import svgUrl from '../../../../rive/nomi-complete/reference/svg-rig/nomi-fullbody-mother.svg?url';

/** 挂到 app 上；返回卸载函数 */
export function mount(app: HTMLElement, mark: (n: string) => void): () => void {
  const img = document.createElement('img');
  img.alt = 'Nomi';
  img.draggable = false;
  img.style.cssText =
    'width:100%;height:100%;object-fit:contain;object-position:50% 100%;display:block;background:transparent;';
  img.onload = () => mark('svg-loaded');
  img.src = svgUrl;
  app.appendChild(img);
  return () => img.remove();
}
