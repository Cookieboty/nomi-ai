/**
 * 设置 → 通用 → 启动 Nomi 后默认显示：看板娘（默认）/ 软件主界面；桌面看板娘显示开关。
 * 主进程 startup/StartupService（ai:startup:*）持久化，下次启动生效；首次引导里有同一个选项。
 */
import { Switch, t, useLocale } from '@nomi-ai/ui';
import React, { useEffect, useState } from 'react';

import {
  startupClient,
  type CloseMainAction,
  type StartupView,
} from '../../services/startupClient';

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

const CLOSE_OPTIONS: { id: CloseMainAction; label: () => string; hint: () => string }[] = [
  {
    id: 'hide',
    label: () => t('隐藏到托盘'),
    hint: () => t('只关闭主界面，看板娘和托盘继续运行（默认）。'),
  },
  {
    id: 'quit',
    label: () => t('退出 Nomi'),
    hint: () => t('关闭主界面即完全退出，看板娘和托盘一起关闭。'),
  },
];

export const StartupSettings: React.FC = () => {
  useLocale();
  const [view, setView] = useState<StartupView | null>(null);
  const [closeMain, setCloseMain] = useState<CloseMainAction | null>(null);
  const [showMascot, setShowMascot] = useState<boolean | null>(null);
  /** 关掉看板娘时默认界面被自动改为主界面：给一条提示 */
  const [switchedNotice, setSwitchedNotice] = useState(false);
  useEffect(() => {
    let alive = true;
    let off: () => void = () => undefined;
    if (startupClient.available()) {
      void startupClient.get().then((v) => alive && setView(v));
      void startupClient.getCloseMain().then((v) => alive && setCloseMain(v));
      void startupClient.getShowMascot().then((v) => alive && setShowMascot(v));
      // 看板娘工具栏里「关闭看板娘」后，这里同步成关闭
      off = startupClient.onShowMascotChange((v, dv) => {
        if (!alive) return;
        setShowMascot(v);
        if (dv) setView(dv);
      });
    }
    return () => {
      alive = false;
      off();
    };
  }, []);
  if (!startupClient.available() || !view || !closeMain || showMascot === null) return null;

  const toggleMascot = (next: boolean) => {
    const prev = showMascot;
    const prevView = view;
    setShowMascot(next);
    setSwitchedNotice(false);
    void startupClient.setShowMascot(next).then((saved) => {
      if (!saved) {
        setShowMascot(prev);
        return;
      }
      setShowMascot(saved.showMascot);
      setView(saved.defaultView);
      // 默认界面原来是看板娘：主进程已改为主界面，告诉用户
      if (!saved.showMascot && prevView === 'mascot' && saved.defaultView === 'main')
        setSwitchedNotice(true);
    });
  };

  const chooseClose = (next: CloseMainAction) => {
    if (next === closeMain) return;
    const prev = closeMain;
    setCloseMain(next);
    void startupClient.setCloseMain(next).then((saved) => setCloseMain(saved ?? prev));
  };

  const choose = (next: StartupView) => {
    if (next === view) return;
    const prev = view;
    setView(next);
    // 切回看板娘：主进程会自动重新打开她（她是进入主界面的入口）
    if (next === 'mascot') setShowMascot(true);
    setSwitchedNotice(false);
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
      <p className={base.muted}>{t('下次启动生效。')}</p>
      <h2 className={base.h2}>{t('桌面看板娘')}</h2>
      <Switch
        checked={showMascot}
        onChange={toggleMascot}
        label={t('显示看板娘')}
        data-testid="startup-show-mascot"
      />
      {switchedNotice && (
        <p className={base.muted} role="status" data-testid="startup-mascot-switched">
          {t('看板娘已关闭，启动后默认显示已改为「软件主界面」。')}
        </p>
      )}
      <p className={base.muted}>
        {view === 'mascot'
          ? t(
              '关闭后看板娘从桌面隐藏、不再播放语音和监听唤醒词；启动后默认显示会自动改为「软件主界面」，保证随时能进入 Nomi。随时可在此重新打开。',
            )
          : t(
              '关闭后看板娘从桌面隐藏、不再播放语音和监听唤醒词；灵动岛和系统通知照常提醒。看板娘工具栏里的「关闭看板娘」也会关掉这里，随时可在此重新打开。',
            )}
      </p>
      <h2 className={base.h2}>{t('关闭主界面时')}</h2>
      <div
        className={styles.opts}
        role="radiogroup"
        aria-label={t('关闭主界面时')}
        data-testid="settings-close-main"
      >
        {CLOSE_OPTIONS.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={closeMain === o.id}
            data-testid={`close-main-${o.id}`}
            className={`${styles.opt} ${closeMain === o.id ? styles.optOn : ''}`}
            onClick={() => chooseClose(o.id)}
          >
            <span className={styles.optTitle}>{o.label()}</span>
            <span className={styles.optHint}>{o.hint()}</span>
          </button>
        ))}
      </div>
      <p className={base.muted}>
        {t(
          '立即生效。⌘Q（macOS）和托盘菜单里的「退出」始终会完全退出；macOS 上红色按钮和 ⌘W 也按这里的选择处理。',
        )}
      </p>
    </section>
  );
};
