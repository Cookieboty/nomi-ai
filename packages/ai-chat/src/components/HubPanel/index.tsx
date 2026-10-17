/**
 * 顶栏「知识 · 记忆 · 日程」快速视图：一个右侧抽屉，里面用标签切换 知识库 / 长期记忆 / 笔记 / 日程。
 * 各标签直接复用设置页里同一批面板（内嵌渲染），所以功能与 test id 与设置页一致；
 * 抽屉头部的「在设置中打开」跳到当前标签在设置里的位置。
 */
import { Modal, ModalHostContext, t, type ModalHost } from '@nomi-ai/ui';
import React, { useRef } from 'react';

import { desktopClient } from '../../services/desktopClient';
import { kbClient } from '../../services/kbClient';
import { memClient } from '../../services/memClient';
import { schedClient } from '../../services/schedClient';
import { KnowledgePanel, MemoryPanel, NotesPanel, SchedulePanel } from '../lazyPanels';
import type { SettingsSection, SettingsTab } from '../SettingsView/sections';

import styles from './index.module.css';

export type HubTab = 'kb' | 'memory' | 'notes' | 'schedule';

/** 标签、可用条件与「在设置中打开」的落点 */
export const HUB_TABS: ReadonlyArray<{
  id: HubTab;
  label: string;
  available: () => boolean;
  settings: [SettingsSection, SettingsTab];
}> = [
  {
    id: 'kb',
    label: '知识库',
    available: () => kbClient.available(),
    settings: ['knowledge', 'kb'],
  },
  {
    id: 'memory',
    label: '长期记忆',
    available: () => memClient.available(),
    settings: ['knowledge', 'memory'],
  },
  {
    id: 'notes',
    label: '笔记',
    available: () => desktopClient.available(),
    settings: ['knowledge', 'notes'],
  },
  {
    id: 'schedule',
    label: '日程',
    available: () => schedClient.available(),
    settings: ['schedule', 'reminders'],
  },
];

const noop = () => undefined;
const INLINE: ModalHost = { mode: 'inline' };

interface Props {
  isVisible: boolean;
  onClose: () => void;
  tab: HubTab;
  onTab: (tab: HubTab) => void;
  onOpenSettings: (section: SettingsSection, tab: SettingsTab) => void;
}

export const HubPanel: React.FC<Props> = ({ isVisible, onClose, tab, onTab, onOpenSettings }) => {
  const tabs = HUB_TABS.filter((x) => x.available());
  const cur = tabs.find((x) => x.id === tab) ?? tabs[0];
  const refs = useRef(new Map<HubTab, HTMLButtonElement>());
  const curId = cur?.id;
  const host: ModalHost = {
    mode: 'drawer',
    onOpenSettings: curId
      ? () => {
          const [section, settingsTab] = HUB_TABS.find((x) => x.id === curId)!.settings;
          onOpenSettings(section, settingsTab);
        }
      : undefined,
  };
  if (!isVisible) return null;

  const onKey = (e: React.KeyboardEvent) => {
    const i = tabs.findIndex((x) => x.id === cur?.id);
    let n = -1;
    if (e.key === 'ArrowRight') n = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') n = (i + tabs.length - 1) % tabs.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = tabs.length - 1;
    if (n < 0) return;
    e.preventDefault();
    const next = tabs[n]!.id;
    onTab(next);
    refs.current.get(next)?.focus();
  };

  return (
    <ModalHostContext.Provider value={host}>
      <Modal
        open
        onClose={onClose}
        title={t('知识 · 记忆 · 日程')}
        size="lg"
        data-testid="hub-panel"
      >
        <div className={styles.stack}>
          <div
            role="tablist"
            aria-label={t('知识 · 记忆 · 日程分区')}
            className={styles.tabs}
            data-testid="hub-tabs"
            onKeyDown={onKey}
          >
            {tabs.map((x) => (
              <button
                key={x.id}
                ref={(el) => {
                  if (el) refs.current.set(x.id, el);
                  else refs.current.delete(x.id);
                }}
                type="button"
                role="tab"
                aria-selected={cur?.id === x.id}
                tabIndex={cur?.id === x.id ? 0 : -1}
                className={`${styles.tab} ${cur?.id === x.id ? styles.tabOn : ''}`}
                data-testid={`hub-tab-${x.id}`}
                onClick={() => onTab(x.id)}
              >
                {t(x.label)}
              </button>
            ))}
          </div>
          <div role="tabpanel" data-testid="hub-body" data-tab={cur?.id}>
            <ModalHostContext.Provider value={INLINE}>
              {cur?.id === 'kb' && <KnowledgePanel key="kb" isVisible onClose={noop} />}
              {cur?.id === 'memory' && <MemoryPanel key="memory" isVisible onClose={noop} />}
              {cur?.id === 'notes' && <NotesPanel key="notes" isVisible onClose={noop} />}
              {cur?.id === 'schedule' && <SchedulePanel key="schedule" isVisible onClose={noop} />}
            </ModalHostContext.Provider>
          </div>
        </div>
      </Modal>
    </ModalHostContext.Provider>
  );
};
