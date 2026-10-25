/**
 * 设置 →「编程助手」→「委派」（docs/design/nomi-delegate-cli.md §4.7）：
 * 允许 Nomi 委派编程助手的总开关，以及按任务类型（编程开发 / PRD / 代码审查 / 调研分析）的默认编程助手。
 * 对话里可以用 `/agent 名字` 临时指定，优先于这里的默认。
 */
import { Input, Select, SettingRow, SettingsGroup, Switch, t } from '@nomi-ai/ui';
import React, { useEffect, useState } from 'react';

import {
  DELEGATE_KINDS,
  delegateClient,
  delegateKindLabel,
  type DelegateCli,
  type DelegateKind,
  type DelegateSettingsView,
} from '../../services/delegateClient';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';

import styles from './index.module.css';

const AUTO = 'auto';

export const DelegateSettings: React.FC = () => {
  const [s, setS] = useState<DelegateSettingsView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    delegateClient
      .settings()
      .then((v) => alive && setS(v))
      .catch((e: unknown) => alive && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, []);

  if (err) return <p className={styles.sub}>{err}</p>;
  if (!s) return null;

  const save = (
    next: Partial<
      Pick<DelegateSettingsView, 'enabled' | 'defaults' | 'defaultProfileId' | 'cheapModel'>
    >,
  ) => {
    const prev = s;
    const optimistic = { ...s, ...next };
    setS(optimistic);
    delegateClient
      .setSettings({
        enabled: optimistic.enabled,
        defaults: optimistic.defaults,
        defaultProfileId: optimistic.defaultProfileId ?? 'default',
        ...(optimistic.cheapModel !== undefined
          ? { cheapModel: optimistic.cheapModel || undefined }
          : s.cheapModel
            ? { cheapModel: s.cheapModel }
            : {}),
        ...(s.profiles ? { profiles: s.profiles } : {}),
      })
      .then((v) =>
        delegateClient.settings().then((full) => {
          setS(full);
          void v;
        }),
      )
      .catch((e: unknown) => {
        setS(prev);
        setErr(e instanceof Error ? e.message : String(e));
      });
  };
  const setDefault = (k: DelegateKind, v: string) => {
    const defaults = { ...s.defaults };
    if (v === AUTO) delete defaults[k];
    else defaults[k] = v as DelegateCli;
    save({ defaults });
  };
  // 下拉只列已安装的；设过但已卸载的保留一项并标出（委派时按「让 Nomi 选」处理）
  const optionsFor = (k: DelegateKind) => {
    const cur = s.defaults[k];
    const list: DelegateCli[] = [...s.installed];
    if (cur && !list.includes(cur)) list.push(cur);
    return [
      { value: AUTO, label: t('ui.chat-settings.let-nomi-choose') },
      ...list.map((c) => ({
        value: c,
        label: t(ENDPOINT_NAME[c]),
        ...(s.installed.includes(c) ? {} : { description: t('ui.mascot-theme.not-installed') }),
      })),
    ];
  };

  return (
    <div data-testid="providers-section-delegate">
      <SettingsGroup
        title={t('ui.chat-settings.handoff')}
        description={t('ui.chat-settings.nomi-can-hand-specific-coding-writing-review-and')}
      >
        <SettingRow
          title={t('ui.chat-settings.let-nomi-hand-off-tasks-to-coding-assistants')}
          description={t('ui.chat-settings.when-off-nomi-won-t-hand-off-subtasks')}
        >
          <Switch
            checked={s.enabled}
            onChange={(v) => save({ enabled: v })}
            aria-label={t('ui.chat-settings.let-nomi-hand-off-tasks-to-coding-assistants')}
            data-testid="delegate-enabled"
          />
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup
        title={t('ui.chat-settings.default-coding-assistant-by-task-type')}
        description={t('ui.chat-settings.used-when-you-haven-t-picked-one-with')}
      >
        {DELEGATE_KINDS.map((k) => (
          <SettingRow key={k} title={delegateKindLabel(k)}>
            <Select
              size="sm"
              value={s.defaults[k] ?? AUTO}
              disabled={!s.enabled}
              aria-label={t('ui.chat-settings.default-for', delegateKindLabel(k))}
              data-testid={`delegate-default-${k}`}
              onChange={(e) => setDefault(k, e.target.value)}
              options={optionsFor(k)}
              menuMinWidth={140}
            />
          </SettingRow>
        ))}
      </SettingsGroup>
      <SettingsGroup
        title={t('ui.chat-settings.default-handoff-model-profile')}
        description={t('ui.chat-settings.which-model-override-to-use-when-handing-off')}
      >
        <SettingRow
          title={t('ui.chat-settings.default-profile')}
          description={t(
            'ui.chat-settings.agentprofile-ids-default-cheap-local-preferlocal-is-metadata',
          )}
        >
          <Select
            size="sm"
            value={s.defaultProfileId ?? 'default'}
            disabled={!s.enabled}
            aria-label={t('ui.chat-settings.default-handoff-model-profile')}
            data-testid="delegate-default-profile"
            onChange={(e) => save({ defaultProfileId: e.target.value })}
            options={(s.availableProfiles ?? []).map((p) => ({
              value: p.id,
              label: p.label,
            }))}
            menuMinWidth={180}
          />
        </SettingRow>
        <SettingRow
          title={t('ui.chat-settings.cheap-model-cheap')}
          description={t('ui.chat-settings.used-when-the-cheap-profile-has-no-model')}
        >
          <Input
            key={s.cheapModel ?? ''}
            size="sm"
            defaultValue={s.cheapModel ?? ''}
            disabled={!s.enabled}
            placeholder="provider/model"
            aria-label={t('ui.chat-settings.cheap-model-cheap')}
            data-testid="delegate-cheap-model"
            onBlur={(e) => {
              const v = e.target.value.trim() || undefined;
              if (v !== (s.cheapModel || undefined)) save({ cheapModel: v });
            }}
          />
        </SettingRow>
      </SettingsGroup>
    </div>
  );
};
