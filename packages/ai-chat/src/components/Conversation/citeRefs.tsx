/**
 * 知识库回答里的引用编号 [n]：在 Markdown 语法树里把正文文本中的 [n] 换成 <sup data-cite="n">，
 * 再由 Markdown 的 sup 组件渲染成可点击的引用按钮（见 Citations.tsx 的 CiteProvider）。
 * 代码 / 行内代码 / 链接里的 [n] 不动；不在来源列表里的编号原样显示为文本。
 */
import { t } from '@nomi-ai/ui';
import React, { createContext, useContext } from 'react';

import type { KbSource } from '../../services/kbClient';

import styles from './Citations.module.css';

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
}

const CITE_RE = /\[(\d{1,2})\]/g;
/** 这些节点里的文字不是正文：不解析引用 */
const SKIP = new Set(['code', 'inlineCode', 'link', 'linkReference', 'definition', 'html']);

function citeNode(n: number): MdNode {
  return {
    type: 'citeRef',
    data: { hName: 'sup', hProperties: { dataCite: String(n) } },
    children: [{ type: 'text', value: `[${n}]` }],
  };
}

/** 把一段文本拆成 文本 / 引用 节点（纯函数，便于测试） */
export function splitCiteText(value: string): MdNode[] {
  const out: MdNode[] = [];
  let last = 0;
  for (const m of value.matchAll(CITE_RE)) {
    if (m.index! > last) out.push({ type: 'text', value: value.slice(last, m.index) });
    out.push(citeNode(Number(m[1])));
    last = m.index! + m[0].length;
  }
  if (!out.length) return [{ type: 'text', value }];
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
  return out;
}

function walk(node: MdNode): void {
  if (!node.children || SKIP.has(node.type)) return;
  const next: MdNode[] = [];
  for (const c of node.children) {
    if (c.type === 'text' && typeof c.value === 'string' && c.value.includes('[')) {
      next.push(...splitCiteText(c.value));
    } else {
      walk(c);
      next.push(c);
    }
  }
  node.children = next;
}

/** remark 插件 */
export function remarkCiteRefs() {
  return (tree: MdNode) => walk(tree);
}

interface CiteCtx {
  byN: Map<number, KbSource>;
  onPick: (s: KbSource) => void;
}

const CiteContext = createContext<CiteCtx | null>(null);

export const CiteProvider: React.FC<{
  sources: KbSource[];
  onPick: (s: KbSource) => void;
  children: React.ReactNode;
}> = ({ sources, onPick, children }) => (
  <CiteContext.Provider value={{ byN: new Map(sources.map((s) => [s.n, s])), onPick }}>
    {children}
  </CiteContext.Provider>
);

/** 引用按钮；编号不在来源里（或不在引用上下文中）时原样显示 [n] */
export const CiteRef: React.FC<{ n: number }> = ({ n }) => {
  const ctx = useContext(CiteContext);
  const s = ctx?.byN.get(n);
  if (!ctx || !s) return <>{`[${n}]`}</>;
  return (
    <button
      type="button"
      className={styles.cite}
      onClick={() => ctx.onPick(s)}
      title={t(s.title)}
      aria-label={t('ui.knowledge-local.source-numbered', n, t(s.title))}
      data-testid="kb-cite"
    >
      {n}
    </button>
  );
};
