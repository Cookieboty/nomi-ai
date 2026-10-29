/**
 * 看板娘窗口：按 mascot.renderer（svg | rive，默认 svg）运行时切换实现（计划 §5）。
 * svg 时不加载 Rive 包；rive 时动态 import('./mascot-rive')，切回 svg 时卸载并释放 WebGL。
 */
import { createClient, createWebSocketClientTransport } from '@nomi-ai/contract';
import { appContract } from '@nomi-ai/contract/app';

import { mount as mountSvg } from './mascot-svg';

type Renderer = 'svg' | 'rive';

const frag = new URLSearchParams(location.hash.slice(1));
const ctl = frag.get('ctl');
const app = document.getElementById('app')!;
const st = document.getElementById('st')!;
const marks: string[] = [];
const mark = (n: string): void => {
  marks.push(n);
  (window as unknown as { __marks: string[] }).__marks = marks;
  document.title = 'Nomi marks: ' + marks.join(',');
  if (ctl) void fetch(`http://${ctl}/mark?n=${encodeURIComponent(n)}`, { mode: 'no-cors' }).catch(() => {});
};
window.addEventListener('error', (e) => (st.textContent = String(e.message)));

let current: Renderer | null = null;
let unmount: (() => void) | null = null;
let seq = 0;

async function apply(r: Renderer): Promise<void> {
  if (r === current) return;
  const my = ++seq;
  current = r;
  unmount?.();
  unmount = null;
  if (r === 'rive') {
    try {
      const m = await import('./mascot-rive');
      if (my !== seq) return;
      unmount = m.mount(app, mark);
      mark('renderer-rive');
      return;
    } catch (e) {
      st.textContent = `Rive 加载失败，改用静态图：${String(e)}`;
      if (my !== seq) return;
      current = 'svg';
    }
  }
  unmount = mountSvg(app, mark);
  mark('renderer-svg');
}

const client = createClient(
  appContract,
  createWebSocketClientTransport({
    url: frag.get('ws') ?? 'ws://127.0.0.1:0',
    token: frag.get('token') ?? '',
    surface: 'mascot',
  }),
);
client.on('mascot.rendererChanged', (r) => void apply(r));
client.mascot
  .getRenderer()
  .then((r) => apply(r))
  .catch(() => apply('svg'));
