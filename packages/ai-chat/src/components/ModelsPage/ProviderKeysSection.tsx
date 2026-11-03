/**
 * 供应商编辑里的 Key 列表：每个 Key 一张两行的小卡片——
 * 第一行序号、名称、启用；第二行掩码值与状态标签，右侧上移 / 下移 / 更换 / 删除。
 * 更换时新值输入框在这张卡片里；新增 Key 默认收起成一个按钮，点开再贴（一次可贴多个）。
 * 草稿与保存逻辑在 ProviderDetailDialog，这里只负责展示与回调。
 */
import { Button, Icon, IconButton, Input, Switch, t, Textarea } from '@nomi-ai/ui';
import { ArrowDown, ArrowUp, KeyRound, Plus, Trash2 } from 'lucide-react';
import React, { useState } from 'react';

import type { ProviderView } from '../../services/gatewayClient';

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
}) => {
  // 没有 Key 时直接展开，免得多点一下
  const [adding, setAdding] = useState(() => !keys.length);
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
                  {!readOnly && (
                    <span className={styles.keyActions}>
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
