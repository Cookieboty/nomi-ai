/**
 * 代码块语法高亮（rehype 插件）：整个应用共用**一个** lowlight 实例，并且按需动态加载。
 * lowlight + highlight.js 常用语法约 180KB（对话窗入口 JS 的近五分之一），首屏用不到：
 * 只有出现带语言标记的代码块（或首屏空闲后）才 `import('lowlight')`，加载完成前代码块先按纯文本显示，
 * 加载好后通知订阅者重渲染。**本文件和 Markdown 渲染链路都不得静态 import 'lowlight'**（有守卫测试）。
 *
 * 旧实现用 rehype-highlight，它在每次创建 unified 处理器时都 `createLowlight(common)` 并注册全部
 * 常用语法；而 react-markdown 每渲染一段 Markdown 就新建一个处理器，切换会话时一屏上百段就是
 * 上百次重复注册（实测占一次切换主线程的约三分之一）。
 */
import type { createLowlight } from 'lowlight';

interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
}

type Lowlight = ReturnType<typeof createLowlight>;

let lowlight: Lowlight | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** 高亮器是否已加载完成 */
export function isHighlighterReady(): boolean {
  return lowlight !== null;
}

/** 订阅「高亮器加载完成」（useSyncExternalStore 用）；返回取消订阅函数 */
export function subscribeHighlighter(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** 触发加载（幂等）；失败时静默退回纯文本，下次出现代码块再重试 */
export function loadHighlighter(): Promise<void> {
  if (lowlight) return Promise.resolve();
  loading ??= import('lowlight')
    .then(({ common, createLowlight: create }) => {
      lowlight = create(common);
      listeners.forEach((fn) => fn());
    })
    .catch(() => undefined)
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** 取 `language-xxx` / `lang-xxx`；显式 `no-highlight` 返回 false；没写语言返回 undefined */
function languageOf(node: HastNode): string | false | undefined {
  const list = node.properties?.className;
  if (!Array.isArray(list)) return undefined;
  let name: string | undefined;
  for (const raw of list) {
    const v = String(raw);
    if (v === 'no-highlight' || v === 'nohighlight') return false;
    if (!name && v.startsWith('lang-')) name = v.slice(5);
    if (!name && v.startsWith('language-')) name = v.slice(9);
  }
  return name;
}

function textOf(node: HastNode): string {
  if (node.type === 'text') return node.value ?? '';
  return node.children ? node.children.map(textOf).join('') : '';
}

function highlightPre(pre: HastNode, lowlight: Lowlight): void {
  const code = pre.children?.find((c) => c.type === 'element' && c.tagName === 'code');
  if (!code) return;
  const lang = languageOf(code);
  if (!lang || !lowlight.registered(lang)) return;
  const className = Array.isArray(code.properties?.className)
    ? (code.properties!.className as unknown[])
    : [];
  if (!className.includes('hljs')) className.unshift('hljs');
  code.properties = { ...code.properties, className };
  const result = lowlight.highlight(lang, textOf(code), { prefix: 'hljs-' });
  if (result.children.length > 0) code.children = result.children as unknown as HastNode[];
}

function walk(node: HastNode, lowlight: Lowlight): void {
  if (node.type === 'element' && node.tagName === 'pre') {
    highlightPre(node, lowlight);
    return;
  }
  node.children?.forEach((c) => walk(c, lowlight));
}

/** rehype 插件：只对带语言标记的围栏代码块高亮（不做语言猜测）；高亮器未加载时什么都不做 */
export function rehypeHighlightShared() {
  return (tree: HastNode): void => {
    if (lowlight) walk(tree, lowlight);
  };
}
