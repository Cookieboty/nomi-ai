/**
 * 对话窗口（简化页）：用仓库里现成的 @nomi-ai/contract 客户端 + WebSocket 传输连 Go 核心，
 * 调契约里的流式过程 `ai.chat.stream`（输入 ChatOptions，chunk 为 ChatChunk，客户端照常做 zod 校验）。
 * WS 地址和一次性 token 由 Go 放在页面地址的片段里（片段不发给服务器）。
 */
import { createClient, createWebSocketClientTransport } from '@nomi-ai/contract';
import { appContract } from '@nomi-ai/contract/app';

const frag = new URLSearchParams(location.hash.slice(1));
const ctlAddr = frag.get('ctl');
const mark = (n: string) => {
  if (ctlAddr)
    void fetch(`http://${ctlAddr}/mark?n=${encodeURIComponent(n)}`, { mode: 'no-cors' }).catch(
      () => {},
    );
};
const status = document.getElementById('status')!;
const out = document.getElementById('out')!;
const transport = createWebSocketClientTransport({
  url: frag.get('ws') ?? 'ws://127.0.0.1:0',
  token: frag.get('token') ?? '',
  surface: 'chat',
});
const client = createClient(appContract, transport);
client
  .$connect()
  .then((i) => {
    status.textContent = `已连接 Go 核心：contract ${i.version.major}.${i.version.minor} / protocol ${i.protocol}`;
    // 测量模式（片段里带 ctl）：连上后自动发一条，把首包/总耗时报给 Go 控制口，CI 上无需点按钮
    if (ctlAddr) (document.getElementById('f') as HTMLFormElement).requestSubmit();
  })
  .catch((e) => (status.textContent = `连接失败：${e}`));

let ctl: AbortController | null = null;
document.getElementById('stop')!.onclick = () => ctl?.abort();
document.getElementById('f')!.onsubmit = async (ev) => {
  ev.preventDefault();
  const q = (document.getElementById('q') as HTMLInputElement).value;
  ctl?.abort();
  ctl = new AbortController();
  out.textContent += `\n> ${q}\n`;
  const t0 = performance.now();
  let first = 0;
  try {
    const stream = client.ai.chat.stream(
      { messages: [{ role: 'user', content: q }] },
      { signal: ctl.signal },
    );
    for await (const chunk of stream) {
      if (!first) first = performance.now() - t0;
      if (chunk.type === 'delta') out.textContent += chunk.content;
      else if (chunk.type === 'done') out.textContent += `\n[done: ${chunk.finishReason}]`;
      else if (chunk.type === 'error') out.textContent += `\n[error: ${chunk.error}]`;
    }
    const total = performance.now() - t0;
    out.textContent += ` 首包 ${first.toFixed(0)}ms，共 ${total.toFixed(0)}ms\n`;
    mark(`chat-done first=${first.toFixed(0)}ms total=${total.toFixed(0)}ms`);
  } catch (e) {
    out.textContent += `\n[${(e as Error).name}: ${(e as Error).message}]\n`;
    mark(`chat-error ${(e as Error).message}`);
  }
};

// —— 设置：mascot.renderer（默认 svg）。开关即时生效：核心广播 mascot.rendererChanged，看板娘窗口热切换。
const toggle = document.getElementById('riveToggle') as HTMLInputElement;
const hasWebGL = (() => {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') ?? c.getContext('webgl'));
  } catch {
    return false;
  }
})();
const setRenderer = (r: 'svg' | 'rive') => client.mascot.setRenderer({ renderer: r });
client.on('mascot.rendererChanged', (r) => (toggle.checked = r === 'rive'));
void client.mascot.getRenderer().then((r) => {
  toggle.checked = r === 'rive';
  toggle.disabled = !hasWebGL && r !== 'rive';
});
toggle.onchange = () => void setRenderer(toggle.checked ? 'rive' : 'svg');

// —— 引导最后一张（可跳过）：默认「保持静态」，只问一次
const OB_KEY = 'nomi.onboarding.mascotRendererAsked';
if (!localStorage.getItem(OB_KEY) && !ctlAddr) {
  const ob = document.getElementById('ob')!;
  const done = (r: 'svg' | 'rive') => {
    localStorage.setItem(OB_KEY, '1');
    ob.hidden = true;
    void setRenderer(r);
  };
  ob.hidden = false;
  const btnStatic = document.getElementById('obStatic') as HTMLButtonElement;
  const btnRive = document.getElementById('obRive') as HTMLButtonElement;
  if (!hasWebGL) {
    btnRive.hidden = true;
    document.getElementById('obNoGl')!.hidden = false;
  }
  btnStatic.onclick = () => done('svg');
  btnRive.onclick = () => done('rive');
  btnStatic.focus();
}
