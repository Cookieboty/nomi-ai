/**
 * 灵动岛页面（data: URL，无 preload、无远程资源）。主进程用
 * `executeJavaScript('__island.show(<JSON>)')` 投递内容；文本一律 textContent 渲染。
 * 点击岛 → location.hash = 'open'，主进程监听 did-navigate-in-page 打开对话窗口。
 * 动画：收起（刘海 / 小胶囊）→ 弹性展开 → 停留 → 收起 → 隐藏窗口。
 */
import { ISLAND_ROW_MAX, type IslandGeometry } from './geometry';
import { ISLAND_ICON_NODES } from './islandIcons';

export function islandHtml(g: IslandGeometry): string {
  const notch = g.mode === 'notch';
  // i18n-ignore: page CSS contains Chinese comments only
  const css = `
  :root { color-scheme: ${notch ? 'dark' : 'light dark'}; --accent: #fb9466; --w: ${g.width}px;
    --h: ${g.height}px; --cw: ${g.collapsed.width}px; --ch: ${g.collapsed.height}px;
    --inset: ${g.inset}px; --padT: ${g.pad.top}px; --padB: ${g.pad.bottom}px; --mx: ${g.margin.x}px;
    --bg: #000; --fg: #f5f2ee; --fg2: rgba(245,242,238,.72); --line: rgba(255,255,255,.07);
    --shadow: 0 4px 14px rgba(0,0,0,.3), 0 1px 3px rgba(0,0,0,.25); }
  ${
    notch
      ? ''
      : `@media (prefers-color-scheme: light) { :root { --bg: rgba(252,251,249,.97); --fg: #201d1a;
    --fg2: rgba(32,29,26,.66); --line: rgba(0,0,0,.09);
    --shadow: 0 4px 14px rgba(40,30,20,.2), 0 1px 3px rgba(40,30,20,.18); } }`
  }
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden;
    font: 500 13px/1.35 -apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text', 'Segoe UI',
      'PingFang SC', 'Microsoft YaHei UI', system-ui, sans-serif; -webkit-user-select: none; }
  /* 岛贴窗口顶部；窗口高度 = 岛高度（+ 胶囊投影留白），不留空黑 */
  #island { position: absolute; top: 0; left: var(--mx); width: var(--cw); height: var(--ch);
    margin-left: calc((var(--w) - var(--cw)) / 2); background: var(--bg); color: var(--fg);
    border-radius: ${notch ? '0 0 14px 14px' : 'calc(var(--ch) / 2)'}; overflow: hidden; cursor: pointer;
    box-shadow: ${notch ? 'none' : 'var(--shadow), 0 0 0 1px var(--line) inset'};
    transition: width .34s cubic-bezier(.22,.9,.3,1), height .34s cubic-bezier(.22,.9,.3,1),
      margin-left .34s cubic-bezier(.22,.9,.3,1), border-radius .34s ease, opacity .18s ease;
    opacity: 0; }
  #island.on { opacity: 1; }
  #island.open { width: var(--w); height: var(--h); margin-left: 0;
    border-radius: ${notch ? '0 0 22px 22px' : '22px'}; }
  /* 内容行：固定宽度 = 展开宽度，高度由内容决定；上下内边距对称，刘海屏只在顶部多一个真实刘海高度 */
  #row { position: absolute; top: 0; left: 50%; width: var(--w); margin-left: calc(var(--w) / -2);
    display: flex; align-items: center; gap: 12px; box-sizing: border-box;
    padding: calc(var(--inset) + var(--padT)) 16px var(--padB); opacity: 0; transform: translateY(-4px);
    transition: opacity .2s ease .08s, transform .28s ease .06s; }
  #island.open #row { opacity: 1; transform: none; }
  #icon { flex: 0 0 36px; height: 36px; border-radius: 11px; display: grid;
    place-items: center; color: var(--accent); background: color-mix(in srgb, var(--accent) 20%, transparent);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent) inset; }
  /* 刘海屏：图标与状态点放进刘海带（避开中间的刘海），文字区紧贴其下，没有死黑 */
  #island.notch #icon { position: absolute; left: 16px; top: calc((var(--inset) - 26px) / 2);
    flex: none; width: 26px; height: 26px; border-radius: 8px; }
  #icon svg { width: 18px; height: 18px; display: block; }
  #island.notch #icon svg { width: 15px; height: 15px; }
  #spark svg { width: 14px; height: 14px; display: block; }
  #island[data-status='running'] #icon svg { animation: spin 1.1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  #island.notch #spark { position: absolute; right: 18px; top: calc((var(--inset) - 16px) / 2);
    line-height: 16px; }
  #island[data-kind='agent'] { --accent: #78aaff; }
  #island[data-kind='reminder'] { --accent: #f5b73d; }
  #island[data-status='running'] { --accent: #6ea8ff; }
  #island[data-status='done'] { --accent: #4cc38a; }
  #island[data-status='failed'] { --accent: #ff6b6b; }
  #island[data-status='attention'] { --accent: #f5b73d; }
  #text { min-width: 0; flex: 1; }
  #ep { display: none; margin-right: 6px; width: 15px; height: 15px; vertical-align: -3px; }
  #ep.on { display: inline-block; }
  #title { font-weight: 650; font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #body { color: var(--fg2); font-weight: 450; white-space: nowrap; overflow: hidden;
    text-overflow: ellipsis; margin-top: 2px; }
  #body:empty { display: none; }
  #spark { flex: 0 0 auto; color: var(--accent); }
  #island[data-status='running'] #spark { animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .35; } }
  @media (prefers-reduced-motion: reduce) { #island, #row { transition: none; } #spark, #icon svg { animation: none !important; } }
  `;
  // i18n-ignore: page script contains Chinese comments only
  const js = `
  const el = document.getElementById('island');
  const $ = (id) => document.getElementById(id);
  // lucide 图标节点（islandIcons.ts）；一律 createElementNS 构造
  const ICONS = ${JSON.stringify(ISLAND_ICON_NODES)};
  const KIND_ICON = { message: 'message', agent: 'agent', reminder: 'reminder', info: 'info' };
  const STATUS_ICON = { done: 'done', failed: 'failed', attention: 'attention', running: 'running' };
  const EP = { claude: 'Claude Code', codex: 'Codex', dsh: 'dsh', grok: 'Grok', nomi: 'Nomi' };
  // same glyphs as ai-chat EndpointIcon (packages/ui/src/brand/endpointGlyphs.ts; lobe-icons MIT)
  const EP_TILE = {
    nomi: { fill: '#FCEFE1', stroke: 'rgba(51,41,31,.14)' },
    claude: { fill: '#d97757' },
    codex: { fill: '#111111', stroke: 'rgba(255,255,255,.22)' },
    dsh: { fill: '#ffffff', stroke: 'rgba(77,107,254,.35)' },
    grok: { fill: '#111111', stroke: 'rgba(255,255,255,.22)' },
  };
  const EP_GLYPH = {
    nomi: [
      { d: 'M84 104 C96 96 112 104 120 128 C128 154 138 188 156 196', stroke: '#F7A67C', sw: 30, tf: 'translate(-0.69 0.81) scale(0.0625)' },
      { d: 'M48 200 C48 120 64 70 100 70 C140 70 142 196 180 196 C204 196 214 176 214 150', stroke: '#33291F', sw: 40, tf: 'translate(-0.69 0.81) scale(0.0625)' },
      { d: 'M200 30 C203 50 210 57 230 60 C210 63 203 70 200 90 C197 70 190 63 170 60 C190 57 197 50 200 30 Z', fill: '#FB9466', tf: 'translate(-0.69 0.81) scale(0.0625)' },
    ],
    claude: [{ d: 'M8 3v10M3 8h10M4.5 4.5l7 7M11.5 4.5l-7 7', stroke: '#fff', sw: 1.5 }],
    codex: [{ d: 'M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z', fill: '#fff', tf: 'translate(3 3) scale(0.4167)' }],
    dsh: [{ d: 'M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z', fill: '#4D6BFE', tf: 'translate(2.4 2.4) scale(0.4667)' }],
    grok: [{ d: 'M6.469 8.776L16.512 23h-4.464L2.005 8.776H6.47zm-.004 7.9l2.233 3.164L6.467 23H2l4.465-6.324zM22 2.582V23h-3.659V7.764L22 2.582zM22 1l-9.952 14.095-2.233-3.163L17.533 1H22z', fill: '#fff', tf: 'translate(3 3) scale(0.4167)' }],
  };
  const SVGNS = 'http://www.w3.org/2000/svg';
  const svgEl = (name, attrs) => {
    const n = document.createElementNS(SVGNS, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  };
  function paintIcon(node, key) {
    node.replaceChildren();
    const svg = svgEl('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      'stroke-width': 1.75, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    for (const [tag, attrs] of ICONS[key] || ICONS.info) svg.append(svgEl(tag, attrs));
    node.append(svg);
  }
  function paintEndpoint(node, ep) {
    node.replaceChildren();
    if (!Object.prototype.hasOwnProperty.call(EP, ep)) return false;
    const title = svgEl('title', {});
    title.textContent = EP[ep];
    const tile = EP_TILE[ep];
    node.append(title, svgEl('rect', tile.stroke
      ? { x: 0.3, y: 0.3, width: 15.4, height: 15.4, rx: 4, fill: tile.fill, stroke: tile.stroke, 'stroke-width': 0.6 }
      : { width: 16, height: 16, rx: 4, fill: tile.fill }));
    for (const g of EP_GLYPH[ep]) {
      const attrs = { d: g.d, fill: g.fill || 'none' };
      if (g.stroke) Object.assign(attrs, { stroke: g.stroke, 'stroke-width': g.sw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
      if (g.tf) attrs.transform = g.tf;
      node.append(svgEl('path', attrs));
    }
    return true;
  }
  let timer = 0;
  window.__island = {
    /** 填充内容并量出内容行高度（岛展开后的高度）；主进程据此设置窗口高度，再调用 play() */
    prepare(n) {
      clearTimeout(timer);
      paintIcon($('icon'), (n.status && STATUS_ICON[n.status]) || KIND_ICON[n.kind] || 'info');
      el.dataset.kind = n.kind || 'info';
      el.dataset.status = n.status || '';
      const ep = String(n.endpoint || '');
      // endpoint icon with accessible name + tooltip
      const known = paintEndpoint($('ep'), ep);
      $('ep').setAttribute('aria-label', known ? EP[ep] : '');
      $('ep').setAttribute('role', known ? 'img' : 'presentation');
      $('ep').dataset.ep = ep;
      $('ep').classList.toggle('on', known);
      $('tt').textContent = String(n.title || '');
      $('body').textContent = String(n.body || '');
      const base = ${g.inset + g.pad.top + g.pad.bottom};
      const h = base + Math.min(${ISLAND_ROW_MAX}, Math.max(${g.rowMin}, Math.ceil($('row').getBoundingClientRect().height) - base));
      document.documentElement.style.setProperty('--h', h + 'px');
      this.height = h;
      return h;
    },
    play(n) {
      el.classList.add('on');
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('open')));
      timer = setTimeout(() => window.__island.hide(), Math.max(1500, (n && n.durationMs) || 4500));
    },
    show(n) { this.prepare(n); this.play(n); return this.height; },
    hide() {
      el.classList.remove('open');
      setTimeout(() => { el.classList.remove('on'); document.title = 'hidden:' + Date.now(); }, 400);
    },
  };
  el.addEventListener('click', () => { location.hash = 'open-' + Date.now(); window.__island.hide(); });
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', () => { timer = setTimeout(() => window.__island.hide(), 1500); });
  paintIcon($('spark'), 'spark');
  document.title = 'ready';
  `;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>${css}</style></head><body>
<div id="island" class="${notch ? 'notch' : 'pill'}" data-mode="${g.mode}" role="status" aria-live="polite"><div id="row"><div id="icon"></div>
<div id="text"><div id="title"><svg id="ep" viewBox="0 0 16 16" width="15" height="15" aria-hidden="false"></svg><span id="tt"></span></div><div id="body"></div></div><div id="spark"></div></div></div>
<script>${js}</script></body></html>`;
}
