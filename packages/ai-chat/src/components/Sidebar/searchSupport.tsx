import { Icon } from '@nomi-ai/ui';
import { Search } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import type { HistorySession } from '../../services/historyClient';
import { ENDPOINT_FULL } from '../../utils/endpointBadge';
import type { Range, SearchField } from '../../utils/fuzzy';

import styles from './index.module.css';
import type { Meta } from './types';

/** 第一条用户消息缓存（跨 Sidebar 实例共享，key = `${id}:${updatedAt}`） */
export const firstUserMessageCache = new Map<string, string>();

/** 把命中区间渲染成 <mark>（区间基于折叠后的文本，与原文等长） */
export const Highlight: React.FC<{ text: string; ranges?: Range[] }> = ({ text, ranges }) => {
  if (!ranges?.length) return <>{text}</>;
  const out: React.ReactNode[] = [];
  let at = 0;
  ranges.forEach(([a, b], i) => {
    if (a >= text.length) return;
    if (a > at) out.push(text.slice(at, a));
    out.push(
      <mark key={i} className={styles.hit}>
        {text.slice(a, Math.min(b, text.length))}
      </mark>,
    );
    at = Math.min(b, text.length);
  });
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
};

export type SearchEntry =
  | { kind: 'conv'; id: string; meta: Meta; title: string; first: string; cwd: string }
  | { kind: 'hist'; id: string; h: HistorySession };

export const fieldsOf = (e: SearchEntry): SearchField[] =>
  e.kind === 'conv'
    ? [
        { text: e.title, weight: 3, highlight: true },
        { text: e.first, weight: 2 },
        { text: e.cwd, weight: 1.5 },
        { text: ENDPOINT_FULL[e.meta.backend](), weight: 1 },
      ]
    : [
        { text: e.h.title, weight: 3, highlight: true },
        { text: e.h.cwd ?? '', weight: 1.5 },
        { text: ENDPOINT_FULL[e.h.backend](), weight: 1 },
      ];

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return v;
}

export const SearchIcon = () => <Icon icon={Search} size={15} />;
