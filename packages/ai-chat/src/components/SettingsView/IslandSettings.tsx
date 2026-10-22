/**
 * 设置 → 通知：灵动岛式通知开关 / 样式 / 类型，测试按钮。主进程 IslandService（island:*）。
 */
import { Button, SettingRow, SettingsGroup, Switch, t } from '@nomi-ai/ui';
import React, { useCallback, useEffect, useState } from 'react';

import styles from './index.module.css';

interface IslandState {
  enabled: boolean;
  style: 'auto' | 'pill';
  kinds: { message: boolean; agent: boolean; reminder: boolean };
  mode: 'notch' | 'pill';
  platform: string;
}

type Invoke = (ch: string, ...a: unknown[]) => Promise<unknown>;
type NamedApi = Record<string, (...a: unknown[]) => Promise<unknown>>;
/** preload 只暴露命名白名单（electronAPI.island.*），这里把通道名映射到具名方法 */
const CHANNELS: Record<string, string> = {
  'island:get': 'get',
  'island:set': 'set',
  'island:test': 'test',
};
const invoke = (): Invoke | null => {
  const api = (window as unknown as { electronAPI?: { island?: NamedApi } }).electronAPI?.island;
  if (!api) return null;
  return (ch, ...a) => {
    const fn = api[CHANNELS[ch] ?? ''];
    return fn ? fn(...a) : Promise.reject(new Error(`unknown channel ${ch}`));
  };
};

export const IslandSettings: React.FC = () => {
  const [s, setS] = useState<IslandState | null>(null);
  const load = useCallback(() => {
    void invoke()?.('island:get').then((v) => setS(v as IslandState));
  }, []);
  useEffect(load, [load]);
  const set = (p: Partial<IslandState>) => void invoke()?.('island:set', p).then(load);

  if (!invoke())
    return (
      <section className={styles.block} data-testid="settings-island">
        <p className={styles.muted}>{t('仅在桌面应用中提供。')}</p>
      </section>
    );
  if (!s) return null;
  const mac = s.platform === 'darwin';
  const KINDS = [
    ['message', t('AI 主动消息'), t('Nomi 主动搭话、每日简报等')],
    ['agent', t('编程助手进度'), t('编程助手完成、需要确认或出错时')],
    ['reminder', t('日程提醒'), t('到点的提醒与定时任务结果')],
  ] as const;
  return (
    <div className={styles.groups} data-testid="settings-island">
      <SettingsGroup
        title={t('灵动岛')}
        description={
          mac
            ? s.mode === 'notch'
              ? t('检测到刘海屏：通知会从刘海里展开，点一下打开对话。')
              : t('当前屏幕没有刘海：通知显示为屏幕顶部居中的胶囊。')
            : t('Windows / Linux 上为可选的顶部胶囊；关闭时沿用 Nomi 气泡与系统通知。')
        }
        actions={
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!s.enabled}
            data-testid="island-test"
            onClick={() => void invoke()?.('island:test')}
          >
            {t('预览一条通知')}
          </Button>
        }
      >
        <SettingRow title={t('启用灵动岛通知')} description={t('关闭后沿用 Nomi 气泡与系统通知。')}>
          <Switch
            checked={s.enabled}
            onChange={(v) => set({ enabled: v })}
            aria-label={t('启用灵动岛通知')}
            data-testid="island-enabled"
          />
        </SettingRow>
        {mac && (
          <SettingRow title={t('始终用顶部胶囊')} description={t('不贴刘海，在屏幕顶部居中显示。')}>
            <Switch
              checked={s.style === 'pill'}
              disabled={!s.enabled}
              onChange={(v) => set({ style: v ? 'pill' : 'auto' })}
              aria-label={t('始终用顶部胶囊（不贴刘海）')}
              data-testid="island-pill"
            />
          </SettingRow>
        )}
      </SettingsGroup>
      <SettingsGroup
        title={t('通知类型')}
        description={t(
          '免打扰时段（日程与日历 → 日程提醒 → 免打扰与通知）内不会弹出。macOS 专注模式没有公开接口，无法自动感知。',
        )}
      >
        {KINDS.map(([k, label, desc]) => (
          <SettingRow key={k} title={label} description={desc}>
            <Switch
              checked={s.kinds[k]}
              disabled={!s.enabled}
              onChange={(v) => set({ kinds: { ...s.kinds, [k]: v } })}
              aria-label={label}
              data-testid={`island-kind-${k}`}
            />
          </SettingRow>
        ))}
      </SettingsGroup>
    </div>
  );
};
