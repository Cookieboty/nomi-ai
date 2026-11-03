/**
 * 供应商编辑里的模型面板（右栏）：搜索、按启用状态筛选、批量启用 / 停用当前筛选出来的模型、
 * 「刷新」重新列出、手动添加。列表可能有几百行：行组件是 memo，回调由调用方保持引用稳定。
 */
import {
  Button,
  Checkbox,
  formatContext,
  Icon,
  IconButton,
  Input,
  Select,
  t,
  useLocale,
} from '@nomi-ai/ui';
import { Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import React, { memo, useMemo, useState } from 'react';

import type { GatewayModel } from '../../services/gatewayClient';

import styles from './index.module.css';
import { metaSourceLabel } from './ModelLimitsGroups';

/** 模型的能力标签：上下文按主进程算出的生效值显示，悬停看来源 */
const ModelBadges: React.FC<{ m: GatewayModel }> = ({ m }) => {
  const eff = m.effective;
  const ctx = eff ? (eff.source === 'default' ? undefined : eff.ctx) : m.ctx;
  const unknown = eff ? eff.source === 'default' : m.metaSource === 'default';
  return (
    <>
      {(eff?.reasoning ?? m.reasoning) && (
        <span className={styles.badgeSoft}>{t('ui.models.reasoning')}</span>
      )}
      {(eff?.vision ?? m.vision) && (
        <span className={styles.badgeSoft}>{t('ui.models.vision')}</span>
      )}
      {ctx ? (
        <span
          className={styles.badgeMuted}
          title={eff ? t('ui.models.meta-source', metaSourceLabel(eff.source)) : undefined}
        >
          {formatContext(ctx)}
        </span>
      ) : null}
      {m.toolCalling === false && (
        <span className={styles.badgeMuted}>{t('ui.models.no-tool-calling')}</span>
      )}
      {unknown && (
        <span className={styles.badgeMuted} title={t('ui.models.limits-unknown-hint')}>
          {t('ui.models.limits-unknown')}
        </span>
      )}
    </>
  );
};

/** 模型列表的一行 */
const ModelRow = memo(function ModelRow({
  m,
  readOnly,
  onSet,
  onRemove,
}: {
  m: GatewayModel;
  readOnly: boolean;
  onSet: (id: string, x: Partial<GatewayModel>) => void;
  onRemove: (id: string) => void;
}) {
  // 语言切换时重渲染：memo 挡住了根组件的更新，这里自己订阅（#140）
  useLocale();
  return (
    <div className={styles.modelRow} data-testid={`pd-model-${m.id}`}>
      <label className={styles.modelCheck}>
        <Checkbox
          disabled={readOnly}
          checked={m.enabled}
          onChange={(e) => onSet(m.id, { enabled: e.target.checked })}
        />
        <span className={styles.modelName} title={m.id}>
          {m.label ?? m.id}
        </span>
      </label>
      <ModelBadges m={m} />
      {!readOnly && (
        <IconButton
          size="sm"
          className={styles.rowEnd}
          label={t('ui.models.remove-model', m.id)}
          icon={<Icon icon={Trash2} size={14} />}
          onClick={() => onRemove(m.id)}
        />
      )}
    </div>
  );
});

type Filter = 'all' | 'on' | 'off';

export const ProviderModelsPanel: React.FC<{
  models: GatewayModel[];
  readOnly: boolean;
  /** 保存 / 检测进行中：「刷新」不可点 */
  busy: boolean;
  detecting: boolean;
  notice: string | null;
  onRefresh: () => void;
  onSet: (id: string, x: Partial<GatewayModel>) => void;
  onSetMany: (ids: ReadonlySet<string>, enabled: boolean) => void;
  onRemove: (id: string) => void;
  onAdd: (id: string) => void;
}> = ({
  models,
  readOnly,
  busy,
  detecting,
  notice,
  onRefresh,
  onSet,
  onSetMany,
  onRemove,
  onAdd,
}) => {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [text, setText] = useState('');
  const enabledCount = models.filter((m) => m.enabled).length;
  /** 搜索（id / 显示名，不分大小写）+ 启用状态筛选 */
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return models.filter(
      (m) =>
        (filter === 'all' || (filter === 'on') === m.enabled) &&
        (!q || m.id.toLowerCase().includes(q) || (m.label ?? '').toLowerCase().includes(q)),
    );
  }, [models, query, filter]);
  const setShown = (enabled: boolean) => onSetMany(new Set(shown.map((m) => m.id)), enabled);
  const add = () => {
    const id = text.trim();
    if (!id) return;
    onAdd(id);
    setText('');
  };

  return (
    <section className={styles.modelPanel} aria-labelledby="pd-models">
      <div className={styles.sectionHead}>
        <h4 id="pd-models" className={styles.groupTitle}>
          {t('ui.foundation.model')}
          <span className={styles.modelCount} data-testid="pd-models-count">
            {t('ui.models.models-enabled-count', String(enabledCount), String(models.length))}
          </span>
        </h4>
        {!readOnly && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={onRefresh}
            data-testid="pd-models-refresh"
          >
            <Icon
              icon={detecting ? Loader2 : RefreshCw}
              size={14}
              className={detecting ? styles.spin : undefined}
            />
            {t('ui.knowledge-local.refresh')}
          </Button>
        )}
      </div>
      {notice && (
        <p className={styles.help} role="status" data-testid="pd-detect-notice">
          {notice}
        </p>
      )}
      <div className={styles.modelTools}>
        <Input
          size="sm"
          type="search"
          className={styles.modelSearch}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('ui.session-workspace.search-models')}
          aria-label={t('ui.session-workspace.search-models')}
          data-testid="pd-model-search"
        />
        <Select
          size="sm"
          className={styles.modelFilter}
          value={filter}
          onChange={(e) => setFilter(e.target.value as Filter)}
          options={[
            { value: 'all', label: t('ui.providers-schedule.all') },
            { value: 'on', label: t('ui.foundation.enabled') },
            { value: 'off', label: t('ui.slash-commands.disabled') },
          ]}
          aria-label={t('ui.models.model-filter')}
          data-testid="pd-model-filter"
        />
        {!readOnly && (
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={!shown.some((m) => !m.enabled)}
              onClick={() => setShown(true)}
              data-testid="pd-models-enable-shown"
            >
              {t('ui.models.enable-shown')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!shown.some((m) => m.enabled)}
              onClick={() => setShown(false)}
              data-testid="pd-models-disable-shown"
            >
              {t('ui.models.disable-shown')}
            </Button>
          </>
        )}
      </div>
      <div className={styles.modelList}>
        {shown.map((m) => (
          <ModelRow key={m.id} m={m} readOnly={readOnly} onSet={onSet} onRemove={onRemove} />
        ))}
        {!shown.length && (
          <span className={styles.modelEmpty}>
            {models.length
              ? t('ui.slash-commands.no-matching-model')
              : t('ui.models.no-models-yet')}
          </span>
        )}
      </div>
      {!readOnly && (
        <div className={styles.addRow}>
          <Input
            size="sm"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
            placeholder={t('ui.models.add-a-model-id-manually')}
            aria-label={t('ui.models.add-a-model-id-manually')}
            data-testid="pd-model-input"
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={!text.trim()}
            onClick={add}
            data-testid="pd-model-add"
          >
            <Icon icon={Plus} size={14} />
            {t('ui.foundation.add')}
          </Button>
        </div>
      )}
    </section>
  );
};
