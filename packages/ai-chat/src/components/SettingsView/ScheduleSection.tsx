/**
 * 设置 → 日程与日历：
 * 「日程提醒」= 提醒（含重复）/ 定时任务 / 主动聊天 / 免打扰；「日历接入」= 系统日历、本地日历、.ics、订阅、CalDAV。
 * 日历读到的日程会进入「日程提醒」里的每日简报，所以放在同一页。
 */
import { t } from '@nomi-ai/ui';
import React from 'react';

import { SchedulePanel } from '../lazyPanels';

import { CalendarSettings } from './CalendarSettings';
import { SectionPage } from './SectionPage';
import { SECTION_TABS, type ScheduleSectionTab } from './sections';

const noop = () => undefined;

export const ScheduleSection: React.FC<{
  tab: ScheduleSectionTab;
  onTab: (tab: ScheduleSectionTab) => void;
}> = ({ tab, onTab }) => (
  <SectionPage
    testId="settings-schedule"
    title="日程与日历"
    tabsLabel="日程与日历分区"
    intro={t(
      '提醒、定时任务和主动聊天在「日程提醒」；系统日历、.ics 与 CalDAV 在「日历接入」。读到的日程会进入每日简报，AI 也能通过日历工具查看。',
    )}
    tabs={SECTION_TABS.schedule}
    value={tab}
    onChange={onTab}
  >
    {tab === 'reminders' ? (
      <SchedulePanel key="s" isVisible onClose={noop} />
    ) : (
      <CalendarSettings />
    )}
  </SectionPage>
);
