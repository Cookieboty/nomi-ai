/** 看板娘窗口（默认 SVG 版）：只用 <img> 显示一张静态 SVG 立绘，不加载 Rive / wasm，无任何动画。 */
import svgUrl from '../../../../rive/nomi-complete/reference/svg-rig/nomi-fullbody-mother.svg?url';

const app = document.getElementById('app')!;
const img = document.createElement('img');
img.alt = 'Nomi';
img.draggable = false;
img.style.cssText =
  'width:100%;height:100%;object-fit:contain;display:block;background:transparent;';
img.onload = () => {
  document.title = 'Nomi marks: svg-loaded';
  const ctl = new URLSearchParams(location.hash.slice(1)).get('ctl');
  if (ctl) void fetch(`http://${ctl}/mark?n=svg-loaded`, { mode: 'no-cors' }).catch(() => {});
};
img.src = svgUrl;
app.appendChild(img);
