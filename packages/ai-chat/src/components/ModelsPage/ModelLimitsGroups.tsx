/**
 * 供应商详情「高级」里与模型窗口相关的两组（docs/design/unified-gateway.md §12.7.2）：
 * - 上下文与输出上限：留空 = 自动（预设 → 模型列表接口 → 内置目录），占位里显示自动值与来源；
 * - 默认开启长上下文：只列按长度分档计价、有标准窗口的模型（各标签还能在输入栏单独切换）。
 */
import { formatContext, Input, Switch, t } from '@nomi-ai/ui';
import React from 'react';

import type { GatewayModel, MetaSource } from '../../services/gatewayClient';

import styles from './index.module.css';

export const metaSourceLabel = (s: MetaSource): string =>
  ({
    user: t('ui.models.meta-source-user'),
    preset: t('ui.models.meta-source-preset'),
    listed: t('ui.models.meta-source-listed'),
    catalog: t('ui.models.meta-source-catalog'),
    default: t('ui.models.meta-source-default'),
  })[s];

/** 用户在「高级」里手填的值（旧数据没有来源但有值的也算）；预设 / 模型列表存下的不算 */
export const userLimit = (m: GatewayModel, k: 'ctx' | 'maxOutput'): number | undefined =>
  !m.metaSource || m.metaSource === 'user' ? m[k] : undefined;

/** 上下文 / 输出上限输入框 → 正整数；留空 / 非法 = undefined（自动） */
const tokenLimitOf = (s: string): number | undefined => {
  const n = Number(s.trim());
  return s.trim() && Number.isInteger(n) && n > 0 && n <= 100_000_000 ? n : undefined;
};

export const ModelLimitsGroups: React.FC<{
  models: GatewayModel[];
  setModel: (id: string, x: Partial<GatewayModel>) => void;
}> = ({ models, setModel }) => {
  const enabled = models.filter((m) => m.enabled);
  const longCapable = enabled.filter((m) => m.effective?.longContext);
  /** 手填上下文 / 输出上限：填了就标为用户设置；两项都清空则回到自动 */
  const setLimit = (m: GatewayModel, k: 'ctx' | 'maxOutput', text: string) => {
    const next = { ctx: userLimit(m, 'ctx'), maxOutput: userLimit(m, 'maxOutput') };
    next[k] = tokenLimitOf(text);
    setModel(m.id, {
      ...next,
      metaSource: next.ctx || next.maxOutput ? 'user' : undefined,
    });
  };
  const auto = (v: number | undefined, src: MetaSource | undefined) =>
    v && src && src !== 'user'
      ? `${t('ui.models.auto-value', formatContext(v))} · ${metaSourceLabel(src)}`
      : undefined;

  return (
    <>
      <div className={styles.advGroup}>
        <div className={styles.groupTitle}>{t('ui.models.model-limits-title')}</div>
        {enabled.map((m) => {
          const eff = m.effective;
          return (
            <div key={m.id} className={styles.wireRow}>
              <span className={styles.keyName}>{m.label ?? m.id}</span>
              <Input
                size="sm"
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                className={styles.tokenInput}
                value={userLimit(m, 'ctx') ?? ''}
                onChange={(e) => setLimit(m, 'ctx', e.target.value)}
                placeholder={auto(eff?.ctx, eff?.source) ?? t('ui.models.context-window')}
                title={t('ui.models.context-window')}
                aria-label={t('ui.models.context-window-for', m.id)}
                data-testid={`pd-model-ctx-${m.id}`}
              />
              <Input
                size="sm"
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                className={styles.tokenInput}
                value={userLimit(m, 'maxOutput') ?? ''}
                onChange={(e) => setLimit(m, 'maxOutput', e.target.value)}
                placeholder={
                  auto(eff?.maxOutput, eff?.maxOutputSource) ?? t('ui.models.max-output')
                }
                title={t('ui.models.max-output')}
                aria-label={t('ui.models.max-output-for', m.id)}
                data-testid={`pd-model-max-output-${m.id}`}
              />
            </div>
          );
        })}
      </div>

      {longCapable.length > 0 && (
        <div className={styles.advGroup}>
          <div className={styles.groupTitle}>{t('ui.models.long-context-default-title')}</div>
          {longCapable.map((m) => {
            const lc = m.effective!.longContext!;
            return (
              <div key={m.id} className={styles.wireRow}>
                <span className={styles.keyName}>{m.label ?? m.id}</span>
                <span className={styles.longHint}>
                  {t(
                    'ui.models.standard-to-long',
                    formatContext(lc.standard),
                    formatContext(lc.full),
                  )}
                </span>
                <Switch
                  checked={m.longContext ?? false}
                  onChange={(v) => setModel(m.id, { longContext: v ? true : undefined })}
                  aria-label={t('ui.models.long-context-by-default-for', m.id)}
                  data-testid={`pd-model-long-${m.id}`}
                />
              </div>
            );
          })}
        </div>
      )}
    </>
  );
};
