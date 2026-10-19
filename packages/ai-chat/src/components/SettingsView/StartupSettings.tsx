/**
 * 设置 → 通用 → 启动 Nomi 后默认显示：看板娘（默认）/ 软件主界面。
 * 主进程 startup/StartupService（ai:startup:*）持久化，下次启动生效；首次引导里有同一个选项。
 */
import { t, useLocale } from '@nomi-ai/ui';
import React, { useEffect, useState } from 'react';

import { startupClient, type StartupView } from '../../services/startupClient';

import base from './index.module.css';
import styles from './StartupSettings.module.css';

const OPTIONS: { id: StartupView; label: () => string; hint: () => string }[] = [
  {
    id: 'mascot',
    label: () => t('看板娘'),
    hint: () => t('桌面上先出现看板娘，需要时点她的「AI 对话」进入主界面（默认）。'),
  },
  {
    id: 'main',
    label: () => t('软件主界面'),
    hint: () => t('启动后直接打开主界面；看板娘仍在桌面待命，定时任务和提醒照常播报。'),
  },
];

export const StartupSettings: React.FC = () => {
  useLocale();
  const [view, setView] = useState<StartupView | null>(null);
  useEffect(() => {
    let alive = true;
    if (startupClient.available()) void startupClient.get().then((v) => alive && setView(v));
    return () => {
      alive = false;
    };
  }, []);
  if (!startupClient.available() || !view) return null;

  const choose = (next: StartupView) => {
    if (next === view) return;
    const prev = view;
    setView(next);
    // 保存失败：回滚到主进程里实际生效的值
    void startupClient.set(next).then((saved) => setView(saved ?? prev));
  };

  return (
    <section className={base.block} data-testid="settings-startup">
      <h2 className={base.h2}>{t('启动 Nomi 后默认显示')}</h2>
      <div className={styles.opts} role="radiogroup" aria-label={t('启动 Nomi 后默认显示')}>
        {OPTIONS.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={view === o.id}
            data-testid={`startup-view-${o.id}`}
            className={`${styles.opt} ${view === o.id ? styles.optOn : ''}`}
            onClick={() => choose(o.id)}
          >
            <span className={styles.optTitle}>{o.label()}</span>
            <span className={styles.optHint}>{o.hint()}</span>
          </button>
        ))}
      </div>
      <p className={base.muted}>
        {t('下次启动生效。由系统登录项自动启动时，主界面不会抢占焦点。')}
      </p>
    </section>
  );
};
