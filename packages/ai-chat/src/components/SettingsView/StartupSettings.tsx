/**
 * 设置 → 通用：「启动与窗口」（语言 + 启动后默认显示 + 关闭主界面时）与「桌面 Nomi」（显示开关 + 大小）两组。
 * 默认界面与看板娘开关互相联动，所以两组由同一个组件持有状态；语言行和大小滑块由调用方以插槽传入。
 * 主进程 startup/StartupService（ai:startup:*）持久化，下次启动生效；首次引导里有同一个选项。
 */
import { SegmentedControl, SettingRow, SettingsGroup, Switch, t, useLocale } from '@nomi-ai/ui';
import React, { useEffect, useState } from 'react';

import {
  startupClient,
  type CloseMainAction,
  type StartupView,
} from '../../services/startupClient';

import base from './index.module.css';

const OPTIONS: { id: StartupView; label: () => string; hint: () => string }[] = [
  {
    id: 'mascot',
    label: () => t('诺米'),
    hint: () => t('桌面上先出现 Nomi，需要时点她的「AI 对话」进入主界面（默认）。'),
  },
  {
    id: 'main',
    label: () => t('软件主界面'),
    hint: () => t('启动后直接打开主界面；Nomi 仍在桌面待命，定时任务和提醒照常播报。'),
  },
];

const CLOSE_OPTIONS: { id: CloseMainAction; label: () => string; hint: () => string }[] = [
  {
    id: 'hide',
    label: () => t('隐藏到托盘'),
    hint: () => t('只关闭主界面，Nomi 和托盘继续运行（默认）。'),
  },
  {
    id: 'quit',
    label: () => t('退出 Nomi'),
    hint: () => t('关闭主界面即完全退出，Nomi 和托盘一起关闭。'),
  },
];

export const StartupSettings: React.FC<{
  /** 放在「启动与窗口」最上面的行（语言） */
  language?: React.ReactNode;
  /** 「桌面 Nomi」组里开关下面的行（大小）；参数为看板娘当前是否显示 */
  mascotSize?: (shown: boolean) => React.ReactNode;
}> = ({ language, mascotSize }) => {
  // 中文句子之间不加空格，英文要
  const sep = useLocale() === 'zh-CN' ? '' : ' ';
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
  if (!startupClient.available() || !view || !closeMain || showMascot === null)
    return language ? (
      <SettingsGroup title={t('启动与窗口')} data-testid="settings-basic-group" id="settings-basic">
        {language}
      </SettingsGroup>
    ) : null;

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

  const viewHint = OPTIONS.find((o) => o.id === view)!.hint();
  const closeHint = CLOSE_OPTIONS.find((o) => o.id === closeMain)!.hint();

  return (
    <>
      <SettingsGroup title={t('启动与窗口')} data-testid="settings-basic-group" id="settings-basic">
        {language}
        <SettingRow
          data-testid="settings-startup"
          title={t('启动 Nomi 后默认显示')}
          description={[viewHint, t('下次启动生效。')].join(sep)}
        >
          <SegmentedControl
            aria-label={t('启动 Nomi 后默认显示')}
            value={view}
            onChange={choose}
            options={OPTIONS.map((o) => ({
              value: o.id,
              label: o.label(),
              testId: `startup-view-${o.id}`,
            }))}
          />
        </SettingRow>
        <SettingRow
          title={t('关闭主界面时')}
          description={[closeHint, t('⌘Q（macOS）与托盘菜单里的「退出」始终完全退出。')].join(sep)}
        >
          <SegmentedControl
            aria-label={t('关闭主界面时')}
            data-testid="settings-close-main"
            value={closeMain}
            onChange={chooseClose}
            options={CLOSE_OPTIONS.map((o) => ({
              value: o.id,
              label: o.label(),
              testId: `close-main-${o.id}`,
            }))}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title={t('桌面 Nomi')} data-testid="settings-mascot-group">
        <SettingRow
          title={t('显示 Nomi')}
          description={
            view === 'mascot'
              ? t(
                  '关闭后 Nomi 从桌面隐藏、不再播放语音和监听唤醒词；启动后默认显示会自动改为「软件主界面」，保证随时能进入 Nomi。随时可在此重新打开。',
                )
              : t(
                  '关闭后 Nomi 从桌面隐藏、不再播放语音和监听唤醒词；灵动岛和系统通知照常提醒。工具栏里的「关闭 Nomi」也会关掉这里，随时可在此重新打开。',
                )
          }
        >
          <Switch
            checked={showMascot}
            onChange={toggleMascot}
            aria-label={t('显示 Nomi')}
            data-testid="startup-show-mascot"
          />
        </SettingRow>
        {switchedNotice && (
          <p className={base.muted} role="status" data-testid="startup-mascot-switched">
            {t('Nomi 已关闭，启动后默认显示已改为「软件主界面」。')}
          </p>
        )}
        {mascotSize?.(showMascot)}
      </SettingsGroup>
    </>
  );
};
