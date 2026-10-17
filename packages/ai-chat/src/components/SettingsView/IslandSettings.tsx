/**
 * 设置 → 通知：灵动岛式通知开关 / 样式 / 类型，测试按钮。主进程 IslandService（island:*）。
 */
import { Button, Switch, t } from '@nomi-ai/ui';
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
  return (
    <section className={styles.block} data-testid="settings-island">
      <h2 className={styles.h2}>{t('灵动岛通知')}</h2>
      <p className={styles.note}>
        {mac
          ? s.mode === 'notch'
            ? t('检测到刘海屏：通知会从刘海里展开，点一下打开对话。')
            : t('当前屏幕没有刘海：通知显示为屏幕顶部居中的胶囊。')
          : t('Windows / Linux 上为可选的顶部胶囊；关闭时沿用 Nomi 气泡与系统通知。')}
      </p>
      <div className={styles.stackSm}>
        <Switch
          checked={s.enabled}
          onChange={(v) => set({ enabled: v })}
          label={t('启用灵动岛通知')}
          data-testid="island-enabled"
        />
        {mac && (
          <Switch
            checked={s.style === 'pill'}
            disabled={!s.enabled}
            onChange={(v) => set({ style: v ? 'pill' : 'auto' })}
            label={t('始终用顶部胶囊（不贴刘海）')}
            data-testid="island-pill"
          />
        )}
        {(
          [
            ['message', t('AI 主动消息')],
            ['agent', t('编程助手进度')],
            ['reminder', t('日程提醒')],
          ] as const
        ).map(([k, label]) => (
          <Switch
            key={k}
            checked={s.kinds[k]}
            disabled={!s.enabled}
            onChange={(v) => set({ kinds: { ...s.kinds, [k]: v } })}
            label={label}
            data-testid={`island-kind-${k}`}
          />
        ))}
      </div>
      <p className={styles.muted}>
        {t(
          '免打扰时段（日程与日历 → 日程提醒 → 免打扰与通知）内不会弹出。macOS 专注模式没有公开接口，无法自动感知。',
        )}
      </p>
      <div className={styles.actions}>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          data-testid="island-test"
          onClick={() => void invoke()?.('island:test')}
        >
          {t('预览一条通知')}
        </Button>
      </div>
    </section>
  );
};
