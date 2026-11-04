/**
 * 供应商编辑里选中模型的设置（模型列表右侧，docs/design/unified-gateway.md §12.7.2）：
 * 一个模型的所有设置都在这里——按哪个已知模型处理、上下文 / 标准窗口 / 输出上限、默认开长上下文、
 * 实际请求名（模型映射）、限定协议。留空 = 自动（预设 → 模型列表接口 → 内置目录），占位里显示自动值与来源。
 */
import { Button, Checkbox, formatContext, Icon, Input, Select, Switch, t } from '@nomi-ai/ui';
import { Trash2 } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';

import {
  gatewayClient,
  WIRE_LABEL,
  type CatalogModel,
  type GatewayModel,
  type MetaSource,
  type Wire,
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

/** 用户手填的值（旧数据没有来源但有值的也算）；预设 / 模型列表存下的不算 */
export const userLimit = (m: GatewayModel, k: 'ctx' | 'maxOutput'): number | undefined =>
  !m.metaSource || m.metaSource === 'user' ? m[k] : undefined;

/** token 数输入框 → 正整数；留空 / 非法 = undefined（自动） */
export const tokenLimitOf = (s: string): number | undefined => {
  const n = Number(s.trim());
  return s.trim() && Number.isInteger(n) && n > 0 && n <= 100_000_000 ? n : undefined;
};

/** 内置模型目录（「按哪个已知模型处理」的选项）；进程内只拉一次 */
function useCatalog(): CatalogModel[] {
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  useEffect(() => {
    let live = true;
    void gatewayClient.catalogModels().then((c) => live && setCatalog(c));
    return () => {
      live = false;
    };
  }, []);
  return catalog;
}

export const ModelDetailPanel: React.FC<{
  model: GatewayModel | undefined;
  /** 这个供应商填了地址的协议（限定协议只在这些里选） */
  urlWires: readonly Wire[];
  readOnly: boolean;
  /** 发给上游的模型名（模型映射里这个模型的一条；没有 = 原名） */
  upstream: string;
  onSet: (id: string, x: Partial<GatewayModel>) => void;
  onUpstream: (id: string, to: string) => void;
  onToggleWire: (m: GatewayModel, w: Wire, on: boolean) => void;
  onRemove: (id: string) => void;
}> = ({ model: m, urlWires, readOnly, upstream, onSet, onUpstream, onToggleWire, onRemove }) => {
  const catalog = useCatalog();
  const likeOptions = useMemo(
    () => [
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
    ],
    [catalog],
  );

  if (!m)
    return (
      <aside className={styles.modelDetail} data-testid="pd-model-detail">
        <p className={styles.muted}>{t('ui.models.pick-a-model-to-edit')}</p>
      </aside>
    );

  const eff = m.effective;
  /** 手填上下文 / 输出上限：填了就标为用户设置；两项都清空则回到自动 */
  const setLimit = (k: 'ctx' | 'maxOutput', text: string) => {
    const next = { ctx: userLimit(m, 'ctx'), maxOutput: userLimit(m, 'maxOutput') };
    next[k] = tokenLimitOf(text);
    onSet(m.id, { ...next, metaSource: next.ctx || next.maxOutput ? 'user' : undefined });
  };
  const auto = (v: number | undefined, src: MetaSource | undefined, fallback: string) =>
    v && src && src !== 'user'
      ? `${t('ui.models.auto-value', formatContext(v))} · ${metaSourceLabel(src)}`
      : fallback;
  // 长上下文开着时 eff.ctx 是标准窗口：上下文的自动值显示完整窗口
  const autoCtx = eff?.longContext ? eff.longContext.full : eff?.ctx;
  const autoStandard = eff?.longContext && !m.ctxStandard ? eff.longContext.standard : undefined;
  const number = (
    testId: string,
    label: string,
    value: number | undefined,
    placeholder: string,
    onChange: (v: string) => void,
  ) => (
    <label className={styles.detailField}>
      <span>{label}</span>
      <Input
        size="sm"
        type="number"
        min={1}
        step={1}
        inputMode="numeric"
        disabled={readOnly}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={`${m.id} · ${label}`}
        data-testid={testId}
      />
    </label>
  );

  return (
    <aside className={styles.modelDetail} data-testid="pd-model-detail" aria-label={m.id}>
      <div className={styles.detailHead}>
        <span className={styles.detailTitle} title={m.id}>
          {m.label ?? m.id}
        </span>
        {!readOnly && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onRemove(m.id)}
            aria-label={t('ui.models.remove-model', m.id)}
            data-testid={`pd-model-remove-${m.id}`}
          >
            <Icon icon={Trash2} size={14} />
            {t('ui.foundation.delete')}
          </Button>
        )}
      </div>

      <label className={styles.detailField}>
        <span>{t('ui.models.spec-col-like')}</span>
        <Select
          size="sm"
          searchable
          disabled={readOnly}
          value={m.like ?? ''}
          options={likeOptions}
          menuMinWidth={260}
          onChange={(e) => onSet(m.id, { like: e.target.value || undefined })}
          aria-label={t('ui.models.like-for', m.id)}
          data-testid={`pd-model-like-${m.id}`}
        />
      </label>
      <p className={styles.detailHint}>{t('ui.models.like-hint')}</p>

      <div className={styles.detailGrid}>
        {number(
          `pd-model-ctx-${m.id}`,
          t('ui.models.context-window'),
          userLimit(m, 'ctx'),
          auto(autoCtx, eff?.source, t('ui.foundation.auto')),
          (v) => setLimit('ctx', v),
        )}
        {number(
          `pd-model-standard-${m.id}`,
          t('ui.models.standard-window'),
          m.ctxStandard,
          autoStandard
            ? t('ui.models.auto-value', formatContext(autoStandard))
            : t('ui.models.no-tier'),
          (v) => onSet(m.id, { ctxStandard: tokenLimitOf(v) }),
        )}
        {number(
          `pd-model-max-output-${m.id}`,
          t('ui.models.max-output'),
          userLimit(m, 'maxOutput'),
          auto(eff?.maxOutput, eff?.maxOutputSource, t('ui.foundation.auto')),
          (v) => setLimit('maxOutput', v),
        )}
      </div>

      {eff?.longContext ? (
        <div className={styles.detailRow}>
          <span>
            {t('ui.models.long-context-by-default')}
            <span className={styles.detailHint}>
              {' '}
              {t(
                'ui.models.standard-to-long',
                formatContext(eff.longContext.standard),
                formatContext(eff.longContext.full),
              )}
            </span>
          </span>
          <Switch
            disabled={readOnly}
            checked={m.longContext ?? false}
            onChange={(v) => onSet(m.id, { longContext: v ? true : undefined })}
            aria-label={t('ui.models.long-context-by-default-for', m.id)}
            data-testid={`pd-model-long-${m.id}`}
          />
        </div>
      ) : (
        <p className={styles.detailHint}>{t('ui.models.standard-window-hint')}</p>
      )}

      {!readOnly && (
        <>
          <label className={styles.detailField}>
            <span>{t('ui.models.upstream-model')}</span>
            <Input
              size="sm"
              value={upstream}
              placeholder={m.id}
              onChange={(e) => onUpstream(m.id, e.target.value)}
              aria-label={t('ui.models.upstream-model-for', m.id)}
              data-testid={`pd-model-upstream-${m.id}`}
            />
          </label>
          {urlWires.length > 1 && (
            <div className={styles.detailField}>
              <span>{t('ui.models.only-these-apis')}</span>
              <div className={styles.wireChecks}>
                {urlWires.map((w) => (
                  <label key={w} className={styles.modelCheck}>
                    <Checkbox
                      checked={m.wires?.includes(w) ?? false}
                      onChange={(e) => onToggleWire(m, w, e.target.checked)}
                      aria-label={t('ui.models.uses', m.id, WIRE_LABEL[w])}
                      data-testid={`pd-model-wire-${m.id}-${w}`}
                    />
                    <span>{WIRE_LABEL[w]}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </aside>
  );
};
