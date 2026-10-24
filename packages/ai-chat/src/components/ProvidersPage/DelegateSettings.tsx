/**
 * 设置 →「编程助手」→「委派」（docs/design/nomi-delegate-cli.md §4.7）：
 * 允许 Nomi 委派编程助手的总开关，以及按任务类型（编程开发 / PRD / 代码审查 / 调研分析）的默认编程助手。
 * 对话里可以用 `/agent 名字` 临时指定，优先于这里的默认。
 */
import { Select, SettingRow, SettingsGroup, Switch, t } from '@nomi-ai/ui';
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

  const save = (next: Pick<DelegateSettingsView, 'enabled' | 'defaults'>) => {
    const prev = s;
    setS({ ...s, ...next });
    delegateClient
      .setSettings({ enabled: next.enabled, defaults: next.defaults })
      .catch((e: unknown) => {
        setS(prev);
        setErr(e instanceof Error ? e.message : String(e));
      });
  };
  const setDefault = (k: DelegateKind, v: string) => {
    const defaults = { ...s.defaults };
    if (v === AUTO) delete defaults[k];
    else defaults[k] = v as DelegateCli;
    save({ enabled: s.enabled, defaults });
  };
  // 下拉只列已安装的；设过但已卸载的保留一项并标出（委派时按「让 Nomi 选」处理）
  const optionsFor = (k: DelegateKind) => {
    const cur = s.defaults[k];
    const list: DelegateCli[] = [...s.installed];
    if (cur && !list.includes(cur)) list.push(cur);
    return [
      { value: AUTO, label: t('让 Nomi 选') },
      ...list.map((c) => ({
        value: c,
        label: t(ENDPOINT_NAME[c]),
        ...(s.installed.includes(c) ? {} : { description: t('未安装') }),
      })),
    ];
  };

  return (
    <div data-testid="providers-section-delegate">
      <SettingsGroup
        title={t('委派')}
        description={t(
          'Nomi 可以把具体的开发、文档、审查、调研任务交给本机的编程助手去做，做完把结果带回对话。对话里用 /agent 名字 可以临时指定交给谁。',
        )}
      >
        <SettingRow
          title={t('允许 Nomi 委派编程助手')}
          description={t('关闭后 Nomi 不会派出子任务，/agent 也不可用。')}
        >
          <Switch
            checked={s.enabled}
            onChange={(v) => save({ enabled: v, defaults: s.defaults })}
            aria-label={t('允许 Nomi 委派编程助手')}
            data-testid="delegate-enabled"
          />
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup
        title={t('按任务类型的默认编程助手')}
        description={t(
          '没有用 /agent 指定、也没有在消息里点名时，按这里选。「让 Nomi 选」时，Nomi 从已安装的编程助手里选。',
        )}
      >
        {DELEGATE_KINDS.map((k) => (
          <SettingRow key={k} title={delegateKindLabel(k)}>
            <Select
              size="sm"
              value={s.defaults[k] ?? AUTO}
              disabled={!s.enabled}
              aria-label={t('{0}默认交给', delegateKindLabel(k))}
              data-testid={`delegate-default-${k}`}
              onChange={(e) => setDefault(k, e.target.value)}
              options={optionsFor(k)}
            />
          </SettingRow>
        ))}
      </SettingsGroup>
    </div>
  );
};
