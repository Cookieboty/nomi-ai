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
  img.decoding = 'async';
  app.appendChild(img);
  // 立绘约 4 MB：若在 load 事件前开始取图，load（Mac WKWebView didFinishNavigation）要等它解码完，
  // Wails mac 又是 didFinishNavigation 后才 Show 窗口 → 看板娘窗口晚 3s+ 出现（D-B11-16）。
  // 2.0.4 也是先 ready-to-show、Rive 资源异步到位；这里同样等文档 load 后再设 src。
  if (document.readyState === 'complete') img.src = svgUrl;
  else window.addEventListener('load', () => { img.src = svgUrl; }, { once: true });
  return () => img.remove();
}
