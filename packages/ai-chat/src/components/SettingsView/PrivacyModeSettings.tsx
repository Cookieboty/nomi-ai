/**
 * 设置 → 隐私与权限 →「隐私模式」（docs/design/secret-privacy.md §12）：
 * 发往云端第三方供应商前把密钥换成占位符，默认开；关闭前要确认，重新打开不需要。
 * 下面是第 2 阶段的细项：每类密钥找到之后怎么处理、自定义密钥、从不脱敏、最近隐藏的密钥。
 * 状态来自网关（ai:gateway:state 的 privacyMode / privacy），旧主进程没有这些字段时不显示对应部分。
 */
import { Button, Input, Notice, Select, SettingRow, SettingsGroup, Switch, t } from '@nomi-ai/ui';
import React, { useCallback, useEffect, useState } from 'react';

import {
  gatewayClient,
  type PrivacyAction,
  type PrivacyLogEntry,
  type PrivacySettings,
} from '../../services/gatewayClient';
import { useGatewayState } from '../../services/nomiModel';
import { formatFullTime } from '../../utils/convTime';

import styles from './index.module.css';

/** 与网关的 PRIVACY_KINDS 一致 */
const KINDS: Array<{ kind: string; label: () => string }> = [
  { kind: 'API_KEY', label: () => t('ui.chat-settings.secret-kind-api-key') },
  { kind: 'TOKEN', label: () => t('ui.chat-settings.secret-kind-token') },
  { kind: 'PRIVATE_KEY', label: () => t('ui.chat-settings.secret-kind-private-key') },
  { kind: 'PASSWORD', label: () => t('ui.chat-settings.secret-kind-password') },
  { kind: 'CUSTOM', label: () => t('ui.chat-settings.secret-kind-custom') },
];

const kindLabel = (kind: string) => KINDS.find((k) => k.kind === kind)?.label() ?? kind;

/** 一条值的辨认信息：类型 · 长度 · 开头几个字符 */
const summary = (e: { kind: string; len: number; head: string }) =>
  t('ui.chat-settings.secret-entry-summary', kindLabel(e.kind), e.len, e.head);

/** 记录多久刷新一次（只在设置页开着时） */
const LOG_POLL_MS = 5000;

export const PrivacyModeSettings: React.FC = () => {
  const state = useGatewayState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (typeof state?.privacyMode !== 'boolean') return null;
  const on = state.privacyMode;

  /** 改完主进程会广播 ai:gateway:changed，useGatewayState 随之刷新 */
  const run = (p: Promise<unknown>) => {
    setBusy(true);
    setError(null);
    return p
      .then(() => true)
      .catch((e: Error) => {
        setError(e.message);
        return false;
      })
      .finally(() => setBusy(false));
  };

  const setMode = (next: boolean) => {
    if (
      !next &&
      !window.confirm(t('ui.chat-settings.turn-off-privacy-mode-keys-will-be-sent-as-is'))
    )
      return;
    void run(gatewayClient.setOptions({ privacyMode: next }));
  };

  return (
    <>
      <SettingsGroup title={t('ui.chat-settings.privacy-mode')} data-testid="settings-privacy-mode">
        <SettingRow
          title={t('ui.chat-settings.hide-keys-before-sending-to-third-party-providers')}
          description={
            on
              ? t('ui.chat-settings.keys-in-chats-files-and-command-output-become-placeholders')
              : t('ui.chat-settings.privacy-mode-is-off-keys-are-sent-as-is')
          }
        >
          <Switch
            checked={on}
            disabled={busy}
            onChange={setMode}
            aria-label={t('ui.chat-settings.hide-keys-before-sending-to-third-party-providers')}
            data-testid="privacy-mode-switch"
          />
        </SettingRow>
        {error && (
          <Notice tone="danger" role="alert" data-testid="privacy-error">
            {error}
          </Notice>
        )}
      </SettingsGroup>
      {state.privacy && (
        <PrivacyDetails settings={state.privacy} disabled={!on || busy} run={run} />
      )}
    </>
  );
};

const PrivacyDetails: React.FC<{
  settings: PrivacySettings;
  disabled: boolean;
  run: (p: Promise<unknown>) => Promise<boolean>;
}> = ({ settings, disabled, run }) => {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [allowValue, setAllowValue] = useState('');
  const [hidden, setHidden] = useState<PrivacyLogEntry[]>([]);

  const refreshLog = useCallback(() => {
    gatewayClient
      .privacyLog()
      .then((l) => setHidden(Array.isArray(l) ? l : []))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    refreshLog();
    const timer = window.setInterval(refreshLog, LOG_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refreshLog]);

  const allowed = new Set(settings.allow.map((a) => a.tag));
  const actionOptions = [
    { value: 'mask', label: t('ui.chat-settings.privacy-action-mask') },
    { value: 'warn', label: t('ui.chat-settings.privacy-action-warn') },
    { value: 'block', label: t('ui.chat-settings.privacy-action-block') },
  ];

  const addSecret = () =>
    void run(gatewayClient.privacyAddSecret(name, value)).then((ok) => {
      if (!ok) return;
      setName('');
      setValue('');
    });
  const addAllow = () =>
    void run(gatewayClient.privacyAddAllow({ value: allowValue })).then((ok) => {
      if (ok) setAllowValue('');
    });

  return (
    <>
      <SettingsGroup
        title={t('ui.chat-settings.what-to-do-when-a-key-is-found')}
        description={t('ui.chat-settings.mask-sends-a-placeholder-warn-sends-as-is-block')}
        data-testid="settings-privacy-actions"
      >
        {KINDS.map(({ kind, label }) => (
          <SettingRow key={kind} title={label()}>
            <Select
              size="sm"
              value={settings.actions[kind] ?? 'mask'}
              disabled={disabled}
              options={actionOptions}
              aria-label={label()}
              data-testid={`privacy-action-${kind}`}
              onChange={(e) =>
                void run(gatewayClient.privacySetAction(kind, e.target.value as PrivacyAction))
              }
            />
          </SettingRow>
        ))}
      </SettingsGroup>

      <SettingsGroup
        title={t('ui.chat-settings.your-own-secrets')}
        description={t('ui.chat-settings.values-without-a-fixed-format-are-masked-once-added')}
        data-testid="settings-privacy-secrets"
      >
        {settings.secrets.map((s) => (
          <SettingRow key={s.id} title={s.name} description={s.masked}>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => void run(gatewayClient.privacyRemoveSecret(s.id))}
              aria-label={`${t('ui.foundation.delete')} ${s.name}`}
            >
              {t('ui.foundation.delete')}
            </Button>
          </SettingRow>
        ))}
        <SettingRow
          title={t('ui.foundation.add')}
          description={
            settings.secrets.length ? undefined : t('ui.chat-settings.nothing-added-yet')
          }
        >
          <form
            className={styles.inlineForm}
            onSubmit={(e) => {
              e.preventDefault();
              addSecret();
            }}
          >
            <Input
              size="sm"
              value={name}
              disabled={disabled}
              placeholder={t('ui.chat-settings.secret-name-e-g-intranet')}
              aria-label={t('ui.foundation.name')}
              data-testid="privacy-secret-name"
              onChange={(e) => setName(e.target.value)}
            />
            <Input
              size="sm"
              type="password"
              autoComplete="off"
              value={value}
              disabled={disabled}
              placeholder={t('ui.chat-settings.secret-value')}
              aria-label={t('ui.chat-settings.secret-value')}
              data-testid="privacy-secret-value"
              onChange={(e) => setValue(e.target.value)}
            />
            <Button
              size="sm"
              type="submit"
              disabled={disabled || !name.trim() || !value.trim()}
              data-testid="privacy-secret-add"
            >
              {t('ui.foundation.add')}
            </Button>
          </form>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup
        title={t('ui.chat-settings.never-mask')}
        description={t('ui.chat-settings.values-mistaken-for-keys-are-sent-as-is')}
        data-testid="settings-privacy-allow"
      >
        {settings.allow.map((a) => (
          <SettingRow key={a.tag} title={summary(a)} description={formatFullTime(a.at)}>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => void run(gatewayClient.privacyRemoveAllow(a.tag))}
              aria-label={`${t('ui.knowledge-local.remove')} ${summary(a)}`}
            >
              {t('ui.knowledge-local.remove')}
            </Button>
          </SettingRow>
        ))}
        <SettingRow title={t('ui.foundation.add')}>
          <form
            className={styles.inlineForm}
            onSubmit={(e) => {
              e.preventDefault();
              addAllow();
            }}
          >
            <Input
              size="sm"
              type="password"
              autoComplete="off"
              value={allowValue}
              disabled={disabled}
              placeholder={t('ui.chat-settings.value-to-let-through')}
              aria-label={t('ui.chat-settings.value-to-let-through')}
              data-testid="privacy-allow-value"
              onChange={(e) => setAllowValue(e.target.value)}
            />
            <Button
              size="sm"
              type="submit"
              disabled={disabled || !allowValue.trim()}
              data-testid="privacy-allow-add"
            >
              {t('ui.foundation.add')}
            </Button>
          </form>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup
        title={t('ui.chat-settings.recently-hidden-keys')}
        description={t('ui.chat-settings.only-kind-length-and-first-characters-are-kept')}
        data-testid="settings-privacy-log"
        actions={
          hidden.length ? (
            <Button
              size="sm"
              variant="ghost"
              data-testid="privacy-log-clear"
              onClick={() => void run(gatewayClient.privacyClearLog()).then(refreshLog)}
            >
              {t('ui.foundation.clear-log')}
            </Button>
          ) : undefined
        }
      >
        {!hidden.length && <SettingRow title={t('ui.chat-settings.no-keys-hidden-yet')} />}
        {hidden.map((e) => (
          <SettingRow
            key={e.placeholder}
            title={summary(e)}
            description={t(
              'ui.chat-settings.hidden-entry-detail',
              e.requests,
              formatFullTime(e.lastAt),
              e.clients.join('、'),
            )}
            data-testid="privacy-log-entry"
          >
            {allowed.has(e.allowTag) ? (
              <span className={styles.letThrough}>{t('ui.chat-settings.let-through')}</span>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                data-testid="privacy-not-a-secret"
                onClick={() =>
                  void run(
                    gatewayClient.privacyAddAllow({
                      tag: e.allowTag,
                      kind: e.kind,
                      len: e.len,
                      head: e.head,
                    }),
                  )
                }
              >
                {t('ui.chat-settings.not-a-secret')}
              </Button>
            )}
          </SettingRow>
        ))}
      </SettingsGroup>
    </>
  );
};
