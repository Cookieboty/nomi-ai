/**
 * 代码块语法高亮（rehype 插件）：整个应用共用**一个** lowlight 实例。
 * 旧实现用 rehype-highlight，它在每次创建 unified 处理器时都 `createLowlight(common)` 并注册全部
 * 常用语法；而 react-markdown 每渲染一段 Markdown 就新建一个处理器，切换会话时一屏上百段就是
 * 上百次重复注册（实测占一次切换主线程的约三分之一）。
 */
import { common, createLowlight } from 'lowlight';

interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
}

const lowlight = createLowlight(common);

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

function highlightPre(pre: HastNode): void {
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

function walk(node: HastNode): void {
  if (node.type === 'element' && node.tagName === 'pre') {
    highlightPre(node);
    return;
  }
  node.children?.forEach(walk);
}

/** rehype 插件：只对带语言标记的围栏代码块高亮（不做语言猜测） */
export function rehypeHighlightShared() {
  return (tree: HastNode): void => walk(tree);
}
