/**
 * 供应商编辑里的 Key 列表：每个 Key 一张两行的小卡片——
 * 第一行序号、名称、启用；第二行掩码值与状态标签，右侧设置 / 上移 / 下移 / 更换 / 删除。
 * 「设置」在卡片里展开这个 Key 的限定协议与限流（并发、每分钟）。
 * 更换时新值输入框在这张卡片里；新增 Key 默认收起成一个按钮，点开再贴（一次可贴多个）。
 * 草稿与保存逻辑在 ProviderDetailDialog，这里只负责展示与回调。
 */
import {
  Button,
  Icon,
  IconButton,
  Input,
  Select,
  Switch,
  t,
  Textarea,
  type SelectOption,
} from '@nomi-ai/ui';
import { ArrowDown, ArrowUp, KeyRound, Plus, SlidersHorizontal, Trash2 } from 'lucide-react';
import React, { useState } from 'react';

import { WIRE_LABEL, type ProviderView, type Wire } from '../../services/gatewayClient';

import styles from './index.module.css';

/** 草稿里的一个 Key（与 ProviderDetailDialog 的 KeyDraft 同形，只取这里用到的字段） */
export interface KeyRowDraft {
  id: string;
  name: string;
  enabled: boolean;
  /** 本次新增的 Key 带明文 */
  value?: string;
  /** 已有 Key 正在更换成的新值（undefined = 没在更换） */
  replace?: string;
  /** 只走这个协议（undefined = 自动） */
  wire?: Wire;
  /** 并发上限 / 每分钟请求数（输入框文本，留空 = 不限） */
  maxConcurrency?: string;
  rpm?: string;
}

const maskNew = (v: string) => (v.length > 8 ? `${v.slice(0, 3)}…${v.slice(-4)}` : '…');

export const ProviderKeysSection: React.FC<{
  keys: KeyRowDraft[];
  views: ProviderView['keys'];
  readOnly: boolean;
  keyName: (k: { name?: string }, i: number) => string;
  looksLikeKey: (s: string) => boolean;
  onSet: (i: number, x: Partial<KeyRowDraft>) => void;
  onMove: (i: number, dir: -1 | 1) => void;
  onDelete: (i: number) => void;
  /** 「添加 Key」框里的文本（填了没点添加也会随保存一起存） */
  text: string;
  onText: (v: string) => void;
  onAdd: () => void;
  canAdd: boolean;
  /** 限定协议的选项（自动 + 各协议） */
  wireOptions: SelectOption[];
  /** 更换输入框里按回车：直接保存（新值立即生效） */
  onCommit: () => void;
}> = ({
  keys,
  views,
  readOnly,
  keyName,
  looksLikeKey,
  onSet,
  onMove,
  onDelete,
  text,
  onText,
  onAdd,
  canAdd,
  wireOptions,
  onCommit,
}) => {
  // 没有 Key 时直接展开，免得多点一下
  const [adding, setAdding] = useState(() => !keys.length);
  /** 展开了设置（限定协议 / 限流）的 Key */
  const [settings, setSettings] = useState<ReadonlySet<string>>(() => new Set());
  const toggleSettings = (id: string) =>
    setSettings((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const open = adding || !!text;

  return (
    <section className={styles.section} aria-labelledby="pd-keys">
      <h4 id="pd-keys" className={styles.groupTitle}>
        {t('ui.models.keys-fallback-in-order')}
      </h4>
      {!keys.length && <span className={styles.muted}>{t('ui.models.no-key-needed')}</span>}
      {keys.length > 0 && (
        <ol className={styles.keyList}>
          {keys.map((k, i) => {
            const view = views.find((x) => x.id === k.id);
            const label = keyName({ name: k.name || view?.name }, i);
            const isNew = typeof k.value === 'string';
            const replacing = k.replace !== undefined;
            const nameIsKey = !readOnly && !!view && !replacing && looksLikeKey(k.name);
            return (
              <li
                key={k.id}
                className={styles.keyCard}
                data-disabled={k.enabled ? undefined : ''}
                data-testid={isNew ? 'pd-new-key' : `pd-key-${k.id}`}
              >
                <div className={styles.keyMain}>
                  <span className={styles.keyIndex} aria-hidden>
                    {i + 1}
                  </span>
                  {readOnly ? (
                    <span className={styles.keyName}>{label}</span>
                  ) : (
                    <Input
                      size="sm"
                      className={styles.keyNameField}
                      value={k.name}
                      placeholder={keyName({}, i)}
                      onChange={(e) => onSet(i, { name: e.target.value })}
                      aria-label={t('ui.models.name-of', label)}
                    />
                  )}
                  {!readOnly && (
                    <Switch
                      checked={k.enabled}
                      onChange={(v) => onSet(i, { enabled: v })}
                      aria-label={t('ui.foundation.enable', label)}
                    />
                  )}
                </div>
                <div className={styles.keyMeta}>
                  <code className={styles.keyMasked}>
                    {isNew ? maskNew(k.value!) : view?.masked}
                  </code>
                  {isNew && <span className={styles.badgeSoft}>{t('ui.models.new')}</span>}
                  {replacing && (
                    <span className={styles.badgeSoft}>{t('ui.models.replacing')}</span>
                  )}
                  {!k.enabled && (
                    <span className={styles.badgeMuted}>{t('ui.slash-commands.disabled')}</span>
                  )}
                  {k.wire && <span className={styles.badgeMuted}>{WIRE_LABEL[k.wire]}</span>}
                  {(k.maxConcurrency || k.rpm) && (
                    <span className={styles.badgeMuted}>{t('ui.model-quality.rate-limited')}</span>
                  )}
                  {!readOnly && (
                    <span className={styles.keyActions}>
                      <IconButton
                        size="sm"
                        label={t('ui.models.key-settings', label)}
                        icon={<Icon icon={SlidersHorizontal} size={14} />}
                        aria-pressed={settings.has(k.id)}
                        onClick={() => toggleSettings(k.id)}
                        data-testid={`pd-key-settings-${k.id}`}
                      />
                      <IconButton
                        size="sm"
                        label={t('ui.models.move-up', label)}
                        icon={<Icon icon={ArrowUp} size={14} />}
                        disabled={i === 0}
                        onClick={() => onMove(i, -1)}
                        data-focus-id={`key-${k.id}-up`}
                        data-testid={`pd-key-up-${k.id}`}
                      />
                      <IconButton
                        size="sm"
                        label={t('ui.models.move-down', label)}
                        icon={<Icon icon={ArrowDown} size={14} />}
                        disabled={i === keys.length - 1}
                        onClick={() => onMove(i, 1)}
                        data-focus-id={`key-${k.id}-down`}
                        data-testid={`pd-key-down-${k.id}`}
                      />
                      {view && (
                        <IconButton
                          size="sm"
                          label={
                            replacing
                              ? t('ui.models.cancel-replacing', label)
                              : t('ui.models.replace', label)
                          }
                          icon={<Icon icon={KeyRound} size={14} />}
                          aria-pressed={replacing}
                          onClick={() => onSet(i, { replace: replacing ? undefined : '' })}
                          data-testid={`pd-key-replace-${k.id}`}
                        />
                      )}
                      <IconButton
                        size="sm"
                        label={t('ui.knowledge-local.delete', label)}
                        icon={<Icon icon={Trash2} size={14} />}
                        onClick={() => onDelete(i)}
                        data-testid={`pd-key-delete-${k.id}`}
                      />
                    </span>
                  )}
                </div>
                {!readOnly && settings.has(k.id) && (
                  <div className={styles.keySettings}>
                    <Select
                      size="sm"
                      options={wireOptions}
                      value={k.wire ?? ''}
                      onChange={(e) => onSet(i, { wire: (e.target.value || undefined) as Wire })}
                      aria-label={t('ui.models.api-restriction-for', label)}
                      data-testid={`pd-key-wire-${k.id}`}
                    />
                    <Input
                      size="sm"
                      type="number"
                      min={1}
                      step={1}
                      inputMode="numeric"
                      value={k.maxConcurrency ?? ''}
                      onChange={(e) => onSet(i, { maxConcurrency: e.target.value })}
                      placeholder={t('ui.models.concurrent')}
                      aria-label={t('ui.models.max-concurrent-requests', label)}
                      data-testid={`pd-key-conc-${k.id}`}
                    />
                    <Input
                      size="sm"
                      type="number"
                      min={1}
                      step={1}
                      inputMode="numeric"
                      value={k.rpm ?? ''}
                      onChange={(e) => onSet(i, { rpm: e.target.value })}
                      placeholder={t('ui.models.per-minute')}
                      aria-label={t('ui.models.max-requests-per-minute', label)}
                      data-testid={`pd-key-rpm-${k.id}`}
                    />
                  </div>
                )}
                {replacing && (
                  <div className={styles.keyReplace}>
                    <Input
                      size="sm"
                      autoFocus
                      autoComplete="off"
                      spellCheck={false}
                      value={k.replace}
                      placeholder={t('ui.models.paste-the-new-key-it-replaces-when-you', label)}
                      onChange={(e) => onSet(i, { replace: e.target.value })}
                      onKeyDown={(e) => {
                        // 回车 = 换上这个新值并保存，不用再去点「保存」
                        if (e.key === 'Enter' && k.replace?.trim()) {
                          e.preventDefault();
                          onCommit();
                        }
                      }}
                      aria-label={t('ui.models.new-value-for', label)}
                      data-testid={`pd-key-replace-input-${k.id}`}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onSet(i, { replace: undefined })}
                      aria-label={t('ui.models.cancel-replacing', label)}
                    >
                      {t('ui.foundation.cancel')}
                    </Button>
                  </div>
                )}
                {nameIsKey && (
                  <span className={styles.errorText} data-testid={`pd-key-name-hint-${k.id}`}>
                    {t('ui.models.this-name-looks-like-a-key-the-name')}{' '}
                    <button
                      type="button"
                      className={styles.linkBtn}
                      onClick={() => onSet(i, { replace: k.name.trim(), name: '' })}
                      data-testid={`pd-key-name-to-replace-${k.id}`}
                    >
                      {t('ui.models.use-it-to-replace-this-key-instead')}
                    </button>
                  </span>
                )}
                {view && !view.decryptable && (
                  <span className={styles.errorText}>
                    {t('ui.models.can-t-be-decrypted-enter-it-again')}
                  </span>
                )}
                {view?.lastError && (
                  <span className={styles.errorText} data-testid={`pd-key-error-${k.id}`}>
                    {view.lastError}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {!readOnly &&
        (open ? (
          <div className={styles.addKeysBox}>
            <Textarea
              rows={3}
              autoFocus={keys.length > 0}
              value={text}
              onChange={(e) => onText(e.target.value)}
              placeholder={t('ui.models.add-keys-one-per-line-placed-after-the')}
              aria-label={t('ui.models.add-keys')}
              data-testid="pd-keys-input"
            />
            <div className={styles.addKeysActions}>
              {keys.length > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    onText('');
                    setAdding(false);
                  }}
                >
                  {t('ui.foundation.cancel')}
                </Button>
              )}
              <Button
                size="sm"
                variant="secondary"
                disabled={!canAdd}
                onClick={() => {
                  onAdd();
                  setAdding(false);
                }}
                data-testid="pd-keys-add"
              >
                <Icon icon={Plus} size={14} />
                {t('ui.foundation.add')}
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setAdding(true)}
              data-testid="pd-keys-open"
            >
              <Icon icon={Plus} size={14} />
              {t('ui.models.add-keys')}
            </Button>
          </div>
        ))}
    </section>
  );
};
