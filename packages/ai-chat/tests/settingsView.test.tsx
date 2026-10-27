// @vitest-environment happy-dom
import { ModalHostContext, Modal, t } from '@nomi-ai/ui';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SettingsView,
  SETTINGS_NAV_GROUPS,
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
  it('nav groups list every section exactly once, in section order', () => {
    expect(SETTINGS_NAV_GROUPS.flat()).toEqual(SETTINGS_SECTIONS.map((s) => s.id));
  });

  it('lists every section and switches between them; Esc returns to chat', () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<Harness onClose={onClose} />);
    for (const s of SETTINGS_SECTIONS) expect(getByTestId(`settings-nav-${s.id}`)).toBeTruthy();
    expect(SETTINGS_SECTIONS.map((s) => s.label)).toContain('ui.chat-settings.usage-and-quality');
    expect(getByTestId('settings-privacy')).toBeTruthy();
    fireEvent.click(getByTestId('settings-nav-general'));
    expect(getByTestId('settings-nav-general').getAttribute('aria-current')).toBe('page');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('SettingsView 导航收起（跟随对话侧栏）', () => {
  it('收起时只留图标：文字隐藏、按钮带名称，仍可切换分区', () => {
    const onSection = vi.fn();
    const r = render(
      <AiChatContextProvider>
        <SettingsView section="general" onSection={onSection} onClose={() => undefined} collapsed />
      </AiChatContextProvider>,
    );
    expect(r.getByTestId('settings-nav').getAttribute('data-collapsed')).toBe('true');
    const models = r.getByTestId('settings-nav-models');
    expect(models.getAttribute('aria-label')).toBe('模型与供应商');
    expect(models.getAttribute('title')).toBe('模型与供应商');
    fireEvent.click(models);
    expect(onSection).toHaveBeenCalledWith('models');
    cleanup();
    const open = render(
      <AiChatContextProvider>
        <SettingsView section="general" onSection={onSection} onClose={() => undefined} />
      </AiChatContextProvider>,
    );
    expect(open.getByTestId('settings-nav').getAttribute('data-collapsed')).toBeNull();
    expect(open.getByTestId('settings-nav-models').getAttribute('aria-label')).toBeNull();
  });
});

describe('SettingsView 合并后的标签页分区', () => {
  const tabs = (r: ReturnType<typeof render>, page: string) =>
    r.getByTestId(`${page}-tabs`).querySelectorAll('[role="tab"]');

  it('隐私与权限：默认「隐私与数据」，可切到「桌面权限」，方向键切换且 aria 状态正确', () => {
    const r = render(<Harness onClose={() => undefined} />);
    const page = 'settings-privacy-page';
    expect(tabs(r, page)).toHaveLength(4);
    expect(r.getByTestId(`${page}-tab-data`).getAttribute('aria-selected')).toBe('true');
    expect(r.getByTestId('settings-privacy')).toBeTruthy();
    // 数据页里的「文件夹授权与操作记录」跳到「桌面权限」标签
    fireEvent.click(r.getByText('文件夹授权与操作记录'));
    expect(r.getByTestId(`${page}-tab-desktop`).getAttribute('aria-selected')).toBe('true');
    expect(r.queryByTestId('settings-privacy')).toBeNull();
    // 方向键循环并移动焦点：桌面权限 → 数据导出 → 回到隐私与数据
    fireEvent.keyDown(r.getByTestId(`${page}-tabs`), { key: 'ArrowRight' });
    expect(r.getByTestId(`${page}-tab-export`).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(r.getByTestId(`${page}-tabs`), { key: 'ArrowRight' });
    expect(r.getByTestId(`${page}-tab-data`).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(r.getByTestId(`${page}-tab-data`));
    // tab 与 tabpanel 互相关联
    const panel = r.getByTestId(`${page}-panel`);
    expect(panel.getAttribute('role')).toBe('tabpanel');
    expect(r.getByTestId(`${page}-tab-data`).getAttribute('aria-controls')).toBe(panel.id);
  });

  it('外发保护单独一个标签：数据页只留入口，点「去设置」切过去', () => {
    const r = render(<Harness onClose={() => undefined} />);
    const page = 'settings-privacy-page';
    expect(r.queryByTestId('settings-outbound')).toBeNull();
    fireEvent.click(r.getByTestId('privacy-go-outbound'));
    expect(r.getByTestId(`${page}-tab-outbound`).getAttribute('aria-selected')).toBe('true');
    expect(r.getByTestId('settings-outbound')).toBeTruthy();
    expect(r.queryByTestId('settings-privacy')).toBeNull();
  });

  it('深链接标签：desktop / export / memory / schedule / local / requests 分别落在对应标签', () => {
    const cases: Array<[SettingsSection, SettingsTab, string]> = [
      ['privacy', 'desktop', 'settings-privacy-page'],
      ['privacy', 'outbound', 'settings-privacy-page'],
      ['privacy', 'export', 'settings-privacy-page'],
      ['knowledge', 'memory', 'settings-knowledge'],
      ['knowledge', 'schedule', 'settings-knowledge'],
      ['general', 'notify', 'settings-general-page'],
      ['models', 'local', 'settings-models-page'],
      ['usage', 'requests', 'settings-usage-page'],
    ];
    for (const [section, tab, page] of cases) {
      const r = render(<Harness onClose={() => undefined} start={section} deepLink={{ tab }} />);
      expect(r.getByTestId(`${page}-tab-${tab}`).getAttribute('aria-selected')).toBe('true');
      expect(r.getByTestId(page).getAttribute('data-tab')).toBe(tab);
      cleanup();
    }
  });

  it('知识与记忆：默认第一个标签，点击切换；日程是第三个标签', () => {
    const k = render(<Harness onClose={() => undefined} start="knowledge" />);
    expect(k.getByTestId('settings-knowledge').getAttribute('data-tab')).toBe('kb');
    fireEvent.click(k.getByTestId('settings-knowledge-tab-memory'));
    expect(k.getByTestId('settings-knowledge').getAttribute('data-tab')).toBe('memory');
    fireEvent.click(k.getByTestId('settings-knowledge-tab-schedule'));
    expect(k.getByTestId('settings-schedule')).toBeTruthy();
  });

  it('侧栏品牌头；「通用」顶部是横幅且无可见页头；其余分区有标题 + 说明、无横幅', () => {
    const r = render(<Harness onClose={() => undefined} start="general" />);
    expect(r.getByTestId('settings-brand').textContent).toContain('Nomi · 诺米');
    expect(r.queryByTestId('settings-sidebar-foot')).toBeNull();
    const banner = r.getByTestId('settings-banner');
    expect(banner.tagName).toBe('IMG');
    expect(banner.getAttribute('aria-hidden')).toBe('true');
    expect(banner.getAttribute('alt')).toBe('');
    expect(banner.getAttribute('src')).toContain('nomi-banner.webp');
    for (const s of SETTINGS_SECTIONS) {
      fireEvent.click(r.getByTestId(`settings-nav-${s.id}`));
      expect(r.getByTestId('settings-section-title').textContent).toBe(t(s.label));
      expect(r.getByRole('main').getAttribute('aria-label')).toBe(t(s.label));
      const general = s.id === 'general';
      expect(r.queryAllByTestId('settings-banner')).toHaveLength(general ? 1 : 0);
      if (general) {
        expect(r.queryByTestId('settings-page-head')).toBeNull();
      } else {
        const head = r.getByTestId('settings-page-head');
        expect(head.querySelector('h1')!.textContent).toBe(t(s.label));
        expect(head.querySelector('p')!.textContent).toBe(t(s.intro));
      }
    }
  });

  it('右侧「配置说明」：非通用分区按 SECTION_HELP 列出卡片说明，通用页没有；侧栏有副标题与「设置」分组', async () => {
    const { SECTION_HELP } = await import('../src/components/SettingsView/sectionHelp');
    const r = render(<Harness onClose={() => undefined} start="general" />);
    expect(r.getByTestId('settings-brand').textContent).toContain('你的桌面 AI 助手');
    expect(r.queryByTestId('settings-help')).toBeNull();
    fireEvent.click(r.getByTestId('settings-nav-models'));
    const help = r.getByTestId('settings-help');
    const items = help.querySelectorAll('li');
    expect(items).toHaveLength(SECTION_HELP.models.length);
    expect(help.textContent).toContain('第三方供应商');
    for (const s of SETTINGS_SECTIONS)
      if (s.id !== 'general') expect(SECTION_HELP[s.id].length).toBeGreaterThan(0);
  });

  it('快捷键：只有应用内快捷键一张表，没有内层标签', () => {
    const r = render(
      <Harness onClose={() => undefined} start="general" deepLink={{ tab: 'shortcuts' }} />,
    );
    expect(r.getByTestId('settings-shortcuts')).toBeTruthy();
    expect(r.queryByTestId('settings-shortcuts-page-tabs')).toBeNull();
    expect(r.queryByTestId('settings-shortcuts-global')).toBeNull();
    expect(r.getByTestId('settings-shortcuts').textContent).not.toContain('截图');
  });

  it('快捷键冲突时顶部出现横幅，列出冲突项；恢复后消失', async () => {
    const { setBinding, resetBindings } = await import('../src/services/shortcuts');
    setBinding('newChat', 'Mod+K'); // 与「命令面板」相同
    const r = render(
      <Harness onClose={() => undefined} start="general" deepLink={{ tab: 'shortcuts' }} />,
    );
    const banner = r.getByTestId('shortcut-conflict-banner');
    expect(banner.textContent).toContain('命令面板');
    expect(banner.textContent).toContain('新对话');
    act(() => resetBindings());
    expect(r.queryByTestId('shortcut-conflict-banner')).toBeNull();
  });

  it('通用：横幅下是版本 / 主题 / 语言速览；分组依次为外观、（启动与窗口）、关于与更新', () => {
    const r = render(<Harness onClose={() => undefined} start="general" />);
    for (const id of ['version', 'theme', 'language'])
      expect(r.getByTestId(`settings-hero-${id}`)).toBeTruthy();
    expect(r.getByTestId('settings-hero-theme').textContent).toContain('主题');
    const appearance = r.getByTestId('settings-appearance');
    expect(appearance.querySelector('[data-testid="theme-settings"]')).toBeTruthy();
    expect(appearance.querySelector('[data-testid="settings-chat-bg"]')).toBeNull();
    expect(appearance.querySelector('[data-testid="theme-image"]')).toBeTruthy();
    // 没有桌面桥时「启动与窗口」只有语言一行
    const g = r.getByTestId('settings-basic-group');
    expect(g.querySelector('[data-testid="language-settings"]')).toBeTruthy();
    const order = [...r.container.querySelectorAll('[data-testid]')]
      .map((e) => e.getAttribute('data-testid'))
      .filter((id) =>
        ['settings-appearance', 'settings-basic-group', 'settings-updates'].includes(id!),
      );
    expect(order).toEqual(['settings-appearance', 'settings-basic-group', 'settings-updates']);
    expect(r.getByTestId('settings-reopen-onboarding')).toBeTruthy();
  });

  it('「用量与质量」：默认用量与费用，切到「对比」懒加载质量面板（不再有自己的标签条）', async () => {
    const r = render(<Harness onClose={() => undefined} start="models" />);
    fireEvent.click(r.getByTestId('settings-nav-usage'));
    expect(r.getByTestId('settings-nav-usage').getAttribute('aria-current')).toBe('page');
    expect(r.getByTestId('settings-section-title').textContent).toBe('用量与质量');
    expect(r.getByTestId('settings-usage-page').getAttribute('data-tab')).toBe('cost');
    fireEvent.click(r.getByTestId('settings-usage-page-tab-compare'));
    const q = await r.findByTestId('settings-quality');
    expect(q.querySelector('[role="tablist"]')).toBeNull();
  });

  it('宽分区（模型质量）不显示右侧说明栏，页头「说明」按钮在页头下展开同一组说明', async () => {
    const { SECTION_HELP } = await import('../src/components/SettingsView/sectionHelp');
    const r = render(<Harness onClose={() => undefined} start="usage" />);
    expect(r.queryByTestId('settings-help')).toBeNull();
    expect(r.queryByTestId('settings-help-inline')).toBeNull();
    const toggle = r.getByTestId('settings-help-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const help = r.getByTestId('settings-help-inline');
    expect(help.querySelectorAll('li')).toHaveLength(SECTION_HELP.usage.length);
    fireEvent.click(toggle);
    expect(r.queryByTestId('settings-help-inline')).toBeNull();
    // 普通分区没有这个按钮
    fireEvent.click(r.getByTestId('settings-nav-models'));
    expect(r.queryByTestId('settings-help-toggle')).toBeNull();
    expect(r.getByTestId('settings-help')).toBeTruthy();
  });

  it('菜单只有合并后的 7 个分区', () => {
    const r = render(<Harness onClose={() => undefined} />);
    const ids = r
      .getAllByTestId(/^settings-nav-/)
      .map((e) => e.getAttribute('data-testid')!.replace('settings-nav-', ''));
    expect(ids).toEqual(['general', 'models', 'coding', 'usage', 'knowledge', 'ext', 'privacy']);
  });

  it('通用：默认「通用」，还有快捷键 / 语音 / 通知标签', () => {
    const r = render(<Harness onClose={() => undefined} start="general" />);
    const page = 'settings-general-page';
    expect(r.getByTestId(page).getAttribute('data-tab')).toBe('basics');
    expect([...tabs(r, page)].map((x) => x.textContent)).toEqual([
      '通用',
      '快捷键',
      '语音',
      '通知 / 灵动岛',
    ]);
    fireEvent.click(r.getByTestId(`${page}-tab-notify`));
    expect(r.getByTestId(page).getAttribute('data-tab')).toBe('notify');
  });

  it('隐私页「导出」按钮切到同页的「数据导出」标签', () => {
    const r = render(<Harness onClose={() => undefined} />);
    fireEvent.click(r.getByTestId('privacy-export'));
    expect(r.getByTestId('settings-privacy-page').getAttribute('data-tab')).toBe('export');
    expect(r.getByTestId('settings-nav-privacy').getAttribute('aria-current')).toBe('page');
  });

  it('知识与记忆没有「笔记」标签；隐私页没有屏幕记忆入口', () => {
    const k = render(<Harness onClose={() => undefined} start="knowledge" />);
    expect(k.queryByTestId('settings-knowledge-tab-notes')).toBeNull();
    cleanup();
    const p = render(<Harness onClose={() => undefined} start="privacy" />);
    expect(p.queryByText('屏幕记忆与排除')).toBeNull();
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
