/**
 * 添加供应商：搜索 + 分类（自定义配置 / 模型厂商 / 第三方平台）+ 预设卡片。
 * 预设只是表单预填模板，点开后进入编辑页，所有字段都可改。
 */
import { t } from '@nomi-ai/ui';
import { Input } from '@nomi-ai/ui';
import { SlidersHorizontal } from 'lucide-react';
import React, { useMemo, useState } from 'react';

import {
  CATEGORY_LABELS,
  PROTOCOL_LABELS,
  type PresetCategory,
  type ProviderPreset,
} from '../../services/providerClient';

import styles from './index.module.css';
import { hostOf, Monogram } from './shared';

const ORDER: PresetCategory[] = ['custom', 'vendor', 'platform'];

export function matchPreset(p: ProviderPreset, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return [p.name, p.websiteUrl, p.baseURL, ...(p.keywords ?? [])]
    .filter(Boolean)
    .some((v) => v!.toLowerCase().includes(s));
}

export const AddProvider: React.FC<{
  presets: ProviderPreset[];
  onPick: (p: ProviderPreset) => void;
}> = ({ presets, onPick }) => {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<PresetCategory | 'all'>('all');
  const hits = useMemo(() => presets.filter((p) => matchPreset(p, q)), [presets, q]);
  const count = (c: PresetCategory | 'all') =>
    c === 'all' ? hits.length : hits.filter((p) => p.category === c).length;
  const shown = ORDER.filter((c) => cat === 'all' || c === cat);

  return (
    <div className={styles.addWrap} data-testid="add-provider">
      <Input
        autoFocus
        data-testid="preset-search"
        placeholder={t('搜索名称或网址，例如 kimi、智谱、openrouter')}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className={styles.addBody}>
        <nav className={styles.catNav}>
          {(['all', ...ORDER] as const).map((c) => (
            <button
              key={c}
              type="button"
              data-testid={`preset-cat-${c}`}
              className={`${styles.catItem} ${cat === c ? styles.catActive : ''}`}
              onClick={() => setCat(c)}
            >
              <span>{c === 'all' ? t('全部') : t(CATEGORY_LABELS[c])}</span>
              <span className="cd-muted">{count(c)}</span>
            </button>
          ))}
        </nav>
        <div className={styles.presetScroll}>
          {shown.map((c) => {
            const list = hits.filter((p) => p.category === c);
            if (list.length === 0) return null;
            return (
              <section key={c}>
                {c !== 'custom' && <h4 className={styles.catTitle}>{t(CATEGORY_LABELS[c])}</h4>}
                <div className={styles.presetGrid}>
                  {list.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={styles.presetCard}
                      data-testid={`preset-${p.id}`}
                      onClick={() => onPick(p)}
                    >
                      <Monogram
                        name={p.name}
                        brand={p.id}
                        fallbackIcon={p.id === 'custom' ? SlidersHorizontal : undefined}
                      />
                      <span className={styles.presetText}>
                        <span className={styles.presetName}>{t(p.name)}</span>
                        <span className="cd-muted">
                          {p.hint ?? hostOf(p.websiteUrl)}
                          {p.id !== 'custom' && ` · ${t(PROTOCOL_LABELS[p.protocol])}`}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            );
          })}
          {hits.length === 0 && (
            <div className="cd-muted">{t('没有匹配的预设，试试「自定义配置」。')}</div>
          )}
        </div>
      </div>
    </div>
  );
};
