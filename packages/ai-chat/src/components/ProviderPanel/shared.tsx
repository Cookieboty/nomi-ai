import { t as tr } from '@nomi-ai/ui';
import { Badge, BrandIcon, hasBrandIcon } from '@nomi-ai/ui';
import { Check, X, type LucideIcon } from 'lucide-react';
import React from 'react';

import type { FetchModelsResult, TestResult } from '../../services/providerClient';

export const fmt = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function parseHeaders(text: string): Record<string, string> | undefined {
  const t = text.trim();
  if (!t) return undefined;
  if (t.startsWith('{')) return JSON.parse(t) as Record<string, string>;
  const out: Record<string, string> = {};
  for (const line of t.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export const headersToText = (h?: Record<string, string>): string =>
  h
    ? Object.entries(h)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n')
    : '';

export const hostOf = (u?: string): string => {
  if (!u) return '';
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

export const TestBadge: React.FC<{ r?: TestResult | 'pending' }> = ({ r }) => {
  if (!r) return null;
  if (r === 'pending') return <Badge tone="neutral">{tr('测速中…')}</Badge>;
  return r.ok ? (
    <Badge tone="success" icon={Check} data-testid="test-ok" title={r.endpoint}>
      {tr('连通')} {r.latencyMs}ms
    </Badge>
  ) : (
    <Badge tone="danger" icon={X} data-testid="test-fail" title={r.error}>
      {r.error?.slice(0, 80)}
    </Badge>
  );
};

export const FetchBadge: React.FC<{ r?: FetchModelsResult | 'pending' }> = ({ r }) => {
  if (!r) return null;
  if (r === 'pending') return <Badge tone="neutral">{tr('获取中…')}</Badge>;
  return r.ok ? (
    <Badge tone="success" icon={Check} data-testid="fetch-ok" title={r.url}>
      {r.models.length} {tr('个模型 ·')} {r.latencyMs}ms
    </Badge>
  ) : (
    <Badge tone="danger" icon={X} data-testid="fetch-fail" title={`${r.url}\n${r.error ?? ''}`}>
      {tr('获取失败：')}
      {r.error?.slice(0, 60)}
    </Badge>
  );
};

const BRAND_ALIAS: Record<string, string> = { siliconflow: 'siliconcloud', claude: 'anthropic' };

/** 预设 / 环境变量供应商 id → 品牌图标 id（@lobehub/icons-static-svg，MIT）；未知返回 undefined */
export function brandOf(id?: string): string | undefined {
  if (!id || id === 'custom') return undefined;
  const b = BRAND_ALIAS[id] ?? id;
  return hasBrandIcon(b) ? b : undefined;
}

/** 供应商头像：有开源授权的品牌图标就用图标，否则首字母 */
export const Monogram: React.FC<{
  name: string;
  size?: number;
  brand?: string;
  fallbackIcon?: LucideIcon;
}> = ({ name, size = 32, brand, fallbackIcon }) => (
  <BrandIcon brand={brandOf(brand)} name={name} size={size} fallbackIcon={fallbackIcon} />
);
