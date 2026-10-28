import { tipPosition } from './tipPosition';

/** 停留多久出提示（ms） */
const SHOW_DELAY = 450;
/** 上一个提示刚收起时（鼠标沿工具栏一路划过），下一个立即出现 */
const WARM_WINDOW = 300;
const BUBBLE_ID = 'cd-title-tip';

const installed = new WeakMap<Document, () => void>();

/**
 * 把整个窗口里的原生 title 提示换成自绘提示（样式跟主题、不被系统延迟左右）。
 *
 * 做法：鼠标悬停（或键盘聚焦）到带 title 的元素时，先把 title 暂时摘下（系统提示就不会出现），
 * 停留一会儿后在元素旁显示 .cd-floating-tip；离开时把 title 原样放回。
 * 这样组件里照常写 title（以及 Button 的 label），不用逐个改成包装组件。
 * 摘下期间若元素只靠 title 取得无障碍名称，临时补上 aria-label，否则用 aria-describedby 关联提示。
 *
 * 返回卸载函数；重复调用只装一次。
 */
export function installTitleTooltips(doc: Document = document): () => void {
  const win = doc.defaultView;
  if (!win) return () => {};
  const existing = installed.get(doc);
  if (existing) return existing;

  let held: HTMLElement | null = null;
  let heldText = '';
  let viaFocus = false;
  let addedLabel = false;
  let addedDesc = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let bubble: HTMLDivElement | null = null;
  let shown = false;
  let lastHiddenAt = 0;

  // React 在提示期间重新写入 title（文案变化）时，接住新文案并再次摘下
  const observer = new win.MutationObserver(() => {
    if (!held?.hasAttribute('title')) return;
    heldText = held.getAttribute('title') ?? '';
    held.removeAttribute('title');
    if (shown) {
      if (heldText.trim()) show();
      else hide();
    }
  });

  const ensureBubble = () => {
    if (!bubble) {
      bubble = doc.createElement('div');
      bubble.id = BUBBLE_ID;
      bubble.setAttribute('role', 'tooltip');
      bubble.className = 'cd-floating-tip cd-floating-tip--title';
    }
    if (!bubble.isConnected) doc.body.appendChild(bubble);
    return bubble;
  };

  const show = () => {
    if (!held?.isConnected || !heldText.trim()) return;
    const b = ensureBubble();
    b.textContent = heldText;
    b.style.visibility = 'hidden';
    b.style.left = '0px';
    b.style.top = '0px';
    const p = tipPosition(held.getBoundingClientRect(), {
      width: b.offsetWidth,
      height: b.offsetHeight,
    });
    b.style.left = `${p.left}px`;
    b.style.top = `${p.top}px`;
    b.style.visibility = '';
    shown = true;
  };

  const hide = () => {
    clearTimeout(timer);
    if (shown) lastHiddenAt = Date.now();
    shown = false;
    bubble?.remove();
  };

  const release = () => {
    hide();
    observer.disconnect();
    const el = held;
    held = null;
    if (!el) return;
    if (!el.hasAttribute('title')) el.setAttribute('title', heldText);
    if (addedLabel) el.removeAttribute('aria-label');
    if (addedDesc) el.removeAttribute('aria-describedby');
    addedLabel = addedDesc = false;
  };

  const hold = (el: HTMLElement, focus: boolean) => {
    release();
    held = el;
    viaFocus = focus;
    heldText = el.getAttribute('title') ?? '';
    el.removeAttribute('title');
    if (heldText.trim()) {
      const named =
        el.hasAttribute('aria-label') ||
        el.hasAttribute('aria-labelledby') ||
        !!el.textContent?.trim();
      if (!named) {
        el.setAttribute('aria-label', heldText);
        addedLabel = true;
      } else if (!el.hasAttribute('aria-describedby')) {
        el.setAttribute('aria-describedby', BUBBLE_ID);
        addedDesc = true;
      }
      const delay = Date.now() - lastHiddenAt < WARM_WINDOW ? 0 : SHOW_DELAY;
      timer = setTimeout(show, delay);
    }
    observer.observe(el, { attributes: true, attributeFilter: ['title'] });
  };

  /** 从 target 往上找最近的带 title 的元素；当前摘下 title 的元素也算 */
  const titledFrom = (target: EventTarget | null): HTMLElement | null => {
    let n = target instanceof win.Element ? target : null;
    while (n && n !== doc.body) {
      if (n === held) return held;
      if (n instanceof win.HTMLElement && n.hasAttribute('title')) return n;
      n = n.parentElement;
    }
    return null;
  };

  const onOver = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    const el = titledFrom(e.target);
    if (el === held) return;
    if (el) hold(el, false);
    else if (held && !viaFocus) release();
  };
  const onOut = (e: PointerEvent) => {
    if (!held || viaFocus) return;
    const to = e.relatedTarget;
    if (to instanceof win.Node && held.contains(to)) return;
    // 移到另一个带 title 的元素由 pointerover 接手；移到空白处就放回
    if (!titledFrom(to)) release();
  };
  const onFocusIn = (e: FocusEvent) => {
    const el = e.target;
    if (!(el instanceof win.HTMLElement) || !el.hasAttribute('title')) return;
    let keyboard: boolean;
    try {
      keyboard = el.matches(':focus-visible');
    } catch {
      keyboard = false;
    }
    if (keyboard) hold(el, true);
  };
  const onFocusOut = (e: FocusEvent) => {
    if (viaFocus && e.target === held) release();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') hide();
  };
  // 点击、滚动、窗口失焦时收起提示；title 仍摘着，直到鼠标离开，免得系统提示补上来
  const onDismiss = () => hide();

  doc.addEventListener('pointerover', onOver, true);
  doc.addEventListener('pointerout', onOut, true);
  doc.addEventListener('pointerdown', onDismiss, true);
  doc.addEventListener('focusin', onFocusIn, true);
  doc.addEventListener('focusout', onFocusOut, true);
  doc.addEventListener('keydown', onKey, true);
  doc.addEventListener('scroll', onDismiss, true);
  win.addEventListener('blur', onDismiss);

  const uninstall = () => {
    release();
    doc.removeEventListener('pointerover', onOver, true);
    doc.removeEventListener('pointerout', onOut, true);
    doc.removeEventListener('pointerdown', onDismiss, true);
    doc.removeEventListener('focusin', onFocusIn, true);
    doc.removeEventListener('focusout', onFocusOut, true);
    doc.removeEventListener('keydown', onKey, true);
    doc.removeEventListener('scroll', onDismiss, true);
    win.removeEventListener('blur', onDismiss);
    installed.delete(doc);
  };
  installed.set(doc, uninstall);
  return uninstall;
}
