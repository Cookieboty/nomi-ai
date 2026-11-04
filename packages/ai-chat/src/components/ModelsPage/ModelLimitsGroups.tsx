/**
 * 供应商详情「高级」里与模型窗口相关的两组（docs/design/unified-gateway.md §12.7.2）：
 * - 模型规格表（每个模型一行）：按哪个已知模型处理（like）、上下文、标准窗口、输出上限。
 *   留空 = 自动（预设 → 模型列表接口 → 内置目录），占位里显示自动值与来源；
 * - 默认开启长上下文：只列有标准窗口的模型（目录里分档计价的，或手填了标准窗口的；各标签还能单独切换）。
 */
import { formatContext, Input, Select, Switch, t } from '@nomi-ai/ui';
import React, { useEffect, useState } from 'react';

import {
  gatewayClient,
  type CatalogModel,
  type GatewayModel,
  type MetaSource,
} from '../../services/gatewayClient';

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
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  useEffect(() => {
    let live = true;
    void gatewayClient.catalogModels().then((c) => live && setCatalog(c));
    return () => {
      live = false;
    };
  }, []);
  const likeOptions = [
    { value: '', label: t('ui.models.like-none') },
    ...catalog.map((c) => ({
      value: c.id,
      label: c.id,
      ...(c.context
        ? {
            description: c.standard
              ? `${formatContext(c.standard)} / ${formatContext(c.context)}`
              : formatContext(c.context),
          }
        : {}),
    })),
  ];
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
        <div className={styles.groupTitle}>{t('ui.models.model-specs-title')}</div>
        <p className={styles.specHint}>{t('ui.models.model-specs-hint')}</p>
        <div
          className={styles.specTable}
          role="table"
          aria-label={t('ui.models.model-specs-title')}
        >
          <div className={styles.specHead} role="row">
            <span role="columnheader">{t('ui.foundation.model')}</span>
            <span role="columnheader">{t('ui.models.spec-col-like')}</span>
            <span role="columnheader">{t('ui.models.context-window')}</span>
            <span role="columnheader">{t('ui.models.standard-window')}</span>
            <span role="columnheader">{t('ui.models.max-output')}</span>
          </div>
          {enabled.map((m) => {
            const eff = m.effective;
            // 长上下文开着时 eff.ctx 是标准窗口：上下文一栏的自动值显示完整窗口
            const autoCtx = eff?.longContext ? eff.longContext.full : eff?.ctx;
            const autoStandard =
              eff?.longContext && !m.ctxStandard ? eff.longContext.standard : undefined;
            return (
              <div key={m.id} className={styles.specRow} role="row">
                <span className={styles.keyName} role="cell" title={m.id}>
                  {m.label ?? m.id}
                </span>
                <span role="cell" className={styles.specCell}>
                  <Select
                    size="sm"
                    searchable
                    value={m.like ?? ''}
                    options={likeOptions}
                    menuMinWidth={280}
                    onChange={(e) => setModel(m.id, { like: e.target.value || undefined })}
                    aria-label={t('ui.models.like-for', m.id)}
                    data-testid={`pd-model-like-${m.id}`}
                  />
                </span>
                <span role="cell" className={styles.specCell}>
                  <Input
                    size="sm"
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    className={styles.tokenInput}
                    value={userLimit(m, 'ctx') ?? ''}
                    onChange={(e) => setLimit(m, 'ctx', e.target.value)}
                    placeholder={auto(autoCtx, eff?.source) ?? t('ui.models.context-window')}
                    title={t('ui.models.context-window')}
                    aria-label={t('ui.models.context-window-for', m.id)}
                    data-testid={`pd-model-ctx-${m.id}`}
                  />
                </span>
                <span role="cell" className={styles.specCell}>
                  <Input
                    size="sm"
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    className={styles.tokenInput}
                    value={m.ctxStandard ?? ''}
                    onChange={(e) => setModel(m.id, { ctxStandard: tokenLimitOf(e.target.value) })}
                    placeholder={
                      autoStandard
                        ? t('ui.models.auto-value', formatContext(autoStandard))
                        : t('ui.models.no-tier')
                    }
                    title={t('ui.models.standard-window')}
                    aria-label={t('ui.models.standard-window-for', m.id)}
                    data-testid={`pd-model-standard-${m.id}`}
                  />
                </span>
                <span role="cell" className={styles.specCell}>
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
                </span>
              </div>
            );
          })}
        </div>
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
