import { Badge, t } from '@nomi-ai/ui';
import { Bot, Terminal } from 'lucide-react';
import React from 'react';

import type { ConversationBackend } from '../../types/chat';
import { AppIcon } from '../AppIcons';
import { EndpointIcon } from '../EndpointIcon';

import { formatMoney } from './format';

export interface Fx {
  currency: 'USD' | 'CNY';
  rate: number;
}

export const moneyOf = (fx: Fx) => (usd: number) => formatMoney(usd, fx.currency, fx.rate);

const BACKENDS = new Set(['nomi', 'claude', 'codex', 'dsh', 'grok']);

/** 来源图标：Nomi / Claude Code / Codex / dsh 用端点品牌图标，其余用通用 lucide 图标 */
export const SourceIcon: React.FC<{ source: string; size?: number }> = ({ source, size = 16 }) =>
  BACKENDS.has(source) ? (
    <EndpointIcon backend={source as ConversationBackend} size={size} decorative />
  ) : (
    <AppIcon icon={source === 'other' ? Bot : Terminal} size={size} />
  );

/** 费用单元格：未定价显示「未定价」，不显示 0 */
export const CostCell: React.FC<{ usd: number | null; fx: Fx }> = ({ usd, fx }) =>
  usd == null ? (
    <Badge tone="warning" data-testid="usage-unpriced">
      {t('未定价')}
    </Badge>
  ) : (
    <>{moneyOf(fx)(usd)}</>
  );
