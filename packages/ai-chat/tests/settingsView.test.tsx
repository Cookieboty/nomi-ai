// @vitest-environment happy-dom
import { ModalHostContext, Modal } from '@nomi-ai/ui';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SettingsView,
  SETTINGS_SECTIONS,
  type SettingsSection,
  type SettingsTab,
} from '../src/components/SettingsView';
import { AiChatContextProvider } from '../src/contexts/AiChatContext';

afterEach(cleanup);

const Harness = ({
  onClose,
  start = 'privacy',
  deepLink,
}: {
  onClose: () => void;
  start?: SettingsSection;
  deepLink?: { tab?: SettingsTab };
}) => {
  const [s, setS] = useState<SettingsSection>(start);
  return (
    <AiChatContextProvider>
      <SettingsView section={s} onSection={setS} onClose={onClose} deepLink={deepLink} />
    </AiChatContextProvider>
  );
};

describe('SettingsView', () => {
  it('lists every section and switches between them; Esc returns to chat', () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<Harness onClose={onClose} />);
    for (const s of SETTINGS_SECTIONS) expect(getByTestId(`settings-nav-${s.id}`)).toBeTruthy();
    expect(SETTINGS_SECTIONS.map((s) => s.label)).toContain('本机管理');
    expect(getByTestId('settings-privacy')).toBeTruthy();
    fireEvent.click(getByTestId('settings-nav-general'));
    expect(getByTestId('settings-nav-general').getAttribute('aria-current')).toBe('page');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('SettingsView 合并后的标签页分区', () => {
  const tabs = (r: ReturnType<typeof render>, page: string) =>
    r.getByTestId(`${page}-tabs`).querySelectorAll('[role="tab"]');

  it('隐私与权限：默认「隐私与数据」，可切到「桌面权限」，方向键切换且 aria 状态正确', () => {
    const r = render(<Harness onClose={() => undefined} />);
    const page = 'settings-privacy-page';
    expect(tabs(r, page)).toHaveLength(2);
    expect(r.getByTestId(`${page}-tab-data`).getAttribute('aria-selected')).toBe('true');
    expect(r.getByTestId('settings-privacy')).toBeTruthy();
    // 数据页里的「文件夹授权与操作记录」跳到「桌面权限」标签
    fireEvent.click(r.getByText('文件夹授权与操作记录'));
    expect(r.getByTestId(`${page}-tab-desktop`).getAttribute('aria-selected')).toBe('true');
    expect(r.queryByTestId('settings-privacy')).toBeNull();
    // 方向键循环并移动焦点
    fireEvent.keyDown(r.getByTestId(`${page}-tabs`), { key: 'ArrowRight' });
    expect(r.getByTestId(`${page}-tab-data`).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(r.getByTestId(`${page}-tab-data`));
    // tab 与 tabpanel 互相关联
    const panel = r.getByTestId(`${page}-panel`);
    expect(panel.getAttribute('role')).toBe('tabpanel');
    expect(r.getByTestId(`${page}-tab-data`).getAttribute('aria-controls')).toBe(panel.id);
  });

  it('深链接标签：desktop / memory / notes / calendar / screen 分别落在对应标签', () => {
    const cases: Array<[SettingsSection, SettingsTab, string]> = [
      ['privacy', 'desktop', 'settings-privacy-page'],
      ['knowledge', 'memory', 'settings-knowledge'],
      ['knowledge', 'notes', 'settings-knowledge'],
      ['schedule', 'calendar', 'settings-schedule'],
      ['senses', 'screen', 'settings-senses'],
    ];
    for (const [section, tab, page] of cases) {
      const r = render(<Harness onClose={() => undefined} start={section} deepLink={{ tab }} />);
      expect(r.getByTestId(`${page}-tab-${tab}`).getAttribute('aria-selected')).toBe('true');
      expect(r.getByTestId(page).getAttribute('data-tab')).toBe(tab);
      cleanup();
    }
  });

  it('知识与记忆、日程与日历：默认第一个标签，点击切换', () => {
    const k = render(<Harness onClose={() => undefined} start="knowledge" />);
    expect(k.getByTestId('settings-knowledge').getAttribute('data-tab')).toBe('kb');
    fireEvent.click(k.getByTestId('settings-knowledge-tab-memory'));
    expect(k.getByTestId('settings-knowledge').getAttribute('data-tab')).toBe('memory');
    cleanup();
    const s = render(<Harness onClose={() => undefined} start="schedule" />);
    expect(s.getByTestId('settings-schedule').getAttribute('data-tab')).toBe('reminders');
    fireEvent.click(s.getByTestId('settings-schedule-tab-calendar'));
    expect(s.getByTestId('settings-calendar')).toBeTruthy();
  });

  it('菜单只有合并后的 11 个分区', () => {
    const r = render(<Harness onClose={() => undefined} />);
    const ids = r
      .getAllByTestId(/^settings-nav-/)
      .map((e) => e.getAttribute('data-testid')!.replace('settings-nav-', ''));
    expect(ids).toEqual([
      'general',
      'shortcuts',
      'coding',
      'usage',
      'senses',
      'knowledge',
      'schedule',
      'notify',
      'ext',
      'local',
      'privacy',
    ]);
  });

  it('语音与屏幕：默认「语音」，可切到「屏幕」', () => {
    const r = render(<Harness onClose={() => undefined} start="senses" />);
    expect(r.getByTestId('settings-senses').getAttribute('data-tab')).toBe('voice');
    fireEvent.click(r.getByTestId('settings-senses-tab-screen'));
    expect(r.getByTestId('settings-senses').getAttribute('data-tab')).toBe('screen');
  });

  it('隐私页「屏幕记忆与排除」跳到 语音与屏幕 → 屏幕 → 隐私与排除；从侧栏再进入则回到默认', async () => {
    const r = render(<Harness onClose={() => undefined} />);
    fireEvent.click(r.getByText('屏幕记忆与排除'));
    expect(r.getByTestId('settings-senses').getAttribute('data-tab')).toBe('screen');
    const inner = await r.findByRole('tab', { name: '隐私与排除' });
    expect(inner.getAttribute('aria-selected')).toBe('true');
    fireEvent.click(r.getByTestId('settings-nav-general'));
    fireEvent.click(r.getByTestId('settings-nav-senses'));
    fireEvent.click(r.getByTestId('settings-senses-tab-screen'));
    const again = await r.findByRole('tab', { name: '隐私与排除' });
    expect(again.getAttribute('aria-selected')).toBe('false');
  });

  it('知识与记忆有「笔记」标签；桌面权限里不再有笔记 / 提醒', () => {
    const k = render(<Harness onClose={() => undefined} start="knowledge" />);
    expect(k.getByTestId('settings-knowledge-tab-notes').textContent).toBe('笔记');
    cleanup();
    const p = render(
      <Harness onClose={() => undefined} start="privacy" deepLink={{ tab: 'desktop' }} />,
    );
    expect(p.queryByRole('tab', { name: '笔记' })).toBeNull();
    expect(p.queryByRole('tab', { name: '提醒' })).toBeNull();
  });
});

describe('Modal host modes', () => {
  it('inline: no overlay / close button; drawer: shows 在设置中打开', () => {
    const r1 = render(
      <ModalHostContext.Provider value={{ mode: 'inline' }}>
        <Modal open onClose={() => undefined} title="T" data-testid="m">
          body
        </Modal>
      </ModalHostContext.Provider>,
    );
    expect(r1.getByTestId('m').closest('.cd-modal-overlay')).toBeNull();
    expect(r1.queryByLabelText('关闭')).toBeNull();
    cleanup();
    const open = vi.fn();
    const r2 = render(
      <ModalHostContext.Provider value={{ mode: 'drawer', onOpenSettings: open }}>
        <Modal open onClose={() => undefined} title="T" data-testid="m">
          <Modal open onClose={() => undefined} title="child" data-testid="child">
            x
          </Modal>
        </Modal>
      </ModalHostContext.Provider>,
    );
    expect(r2.getByTestId('m').className).toContain('cd-modal--drawer');
    // 子对话框不继承宿主模式
    expect(r2.getByTestId('child').className).not.toContain('cd-modal--drawer');
    fireEvent.click(r2.getAllByTestId('open-in-settings')[0]!);
    expect(open).toHaveBeenCalled();
  });
});
