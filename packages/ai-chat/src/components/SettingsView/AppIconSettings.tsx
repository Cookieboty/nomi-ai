/**
 * 设置 → 通用：应用图标（sunset 默认 / cream / ink）。主进程 core/appIcon.ts（app-icon:*）。
 */
import { t } from '@nomi-ai/ui';
import React, { useEffect, useState } from 'react';

import styles from './index.module.css';

type Variant = 'ink' | 'cream' | 'sunset';
interface IconState {
  variant: Variant;
  platform: string;
  previews: Record<Variant, string>;
}
type Invoke = (ch: string, ...a: unknown[]) => Promise<unknown>;
type NamedApi = Record<string, (...a: unknown[]) => Promise<unknown>>;
/** preload 只暴露命名白名单（electronAPI.appIcon.*），这里把通道名映射到具名方法 */
const CHANNELS: Record<string, string> = { 'app-icon:get': 'get', 'app-icon:set': 'set' };
const invoke = (): Invoke | null => {
  const api = (window as unknown as { electronAPI?: { appIcon?: NamedApi } }).electronAPI?.appIcon;
  if (!api) return null;
  return (ch, ...a) => {
    const fn = api[CHANNELS[ch] ?? ''];
    return fn ? fn(...a) : Promise.reject(new Error(`unknown channel ${ch}`));
  };
};

const LABEL: Record<Variant, string> = { sunset: '日落橙（默认）', cream: '奶油', ink: '墨色' };

export const AppIconSettings: React.FC = () => {
  const [s, setS] = useState<IconState | null>(null);
  useEffect(() => {
    void invoke()?.('app-icon:get').then((v) => setS(v as IconState));
  }, []);
  if (!invoke() || !s) return null;
  const pick = (v: Variant) =>
    void invoke()?.('app-icon:set', v).then((r) => setS({ ...s, variant: r as Variant }));
  return (
    <section className={styles.block} data-testid="settings-app-icon">
      <h2 className={styles.h2}>{t('应用图标')}</h2>
      <div role="radiogroup" aria-label={t('应用图标')} style={{ display: 'flex', gap: 16 }}>
        {(Object.keys(LABEL) as Variant[]).map((v) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={s.variant === v}
            data-variant={v}
            onClick={() => pick(v)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 6,
              padding: 10,
              borderRadius: 14,
              cursor: 'pointer',
              background: 'transparent',
              color: 'inherit',
              border:
                s.variant === v
                  ? '2px solid var(--color-accent, #FB9466)'
                  : '2px solid transparent',
            }}
          >
            <img src={s.previews[v]} width={64} height={64} alt="" />
            <span>{t(LABEL[v])}</span>
          </button>
        ))}
      </div>
      <p className={styles.muted}>
        {s.platform === 'darwin'
          ? t(
              '立即更新 Dock 图标（仅本次运行期间；退出后 Finder / 启动台仍显示默认墨色图标）。菜单栏托盘保持单色模板图标。',
            )
          : t(
              '立即更新窗口、正在运行的任务栏按钮和托盘图标。已固定到任务栏的图标由系统缓存，可能要重启应用后才更新（个别情况需取消固定后重新固定）；安装包、可执行文件和开始菜单 / 桌面快捷方式始终为默认墨色。',
            )}
      </p>
    </section>
  );
};
