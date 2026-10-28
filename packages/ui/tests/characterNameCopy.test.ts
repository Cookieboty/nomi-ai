import { spaceAround } from '@nomi-ai/i18n';
import { afterEach, describe, expect, it } from 'vitest';

import { applyLocale, tName } from '../src';

// 带角色名的界面文案（docs/BRAND.md）：「Nomi·诺米」是一个完整的名字。官方角色的全名「Nomi·诺米」只在
// 第一次提到时用，之后用简称「Nomi」；中文里不单独写「诺米」。官方角色下这些文案与 2.0.5 一致，
// 例外：2.0.5 单独写「诺米」的地方（改为 Nomi），以及 G5 把「她 / her」改成中性的「它 / it」。
const FULL = { zh: 'Nomi·诺米', en: 'Nomi' };
const SHORT = { zh: 'Nomi', en: 'Nomi' };

const CASES: Array<[key: string, name: 'full' | 'short', zh: string, en: string]> = [
  ['ui.mascot-theme.welcome-title', 'full', '你好，我是 Nomi·诺米', "Hi, I'm Nomi"],
  [
    'ui.mascot-theme.hi-i-m-nomi-your-ai-companion-who',
    'full',
    '你好，我是 Nomi·诺米，住在你桌面上的 AI 伙伴。花一分钟认识一下吧！',
    'Hi, I’m Nomi — your AI companion who lives on your desktop. Let’s get to know each other in a minute!',
  ],
  ['electron.common.nomi-motions', 'short', 'Nomi 动作', 'Nomi motions'],
  [
    'ui.chat-settings.nomi-is-hidden-show-it-to-adjust-its',
    'short',
    'Nomi 已隐藏，打开后才能调整大小。',
    'Nomi is hidden; show it to adjust its size.',
  ],
  [
    'ui.chat-settings.when-off-system-notifications-are-used-while-nomi',
    'short',
    '关闭后，Nomi 不在桌面时改用系统通知。',
    'When off, system notifications are used while Nomi is closed.',
  ],
  [
    'ui.mascot-theme.closing-the-main-window-quits-nomi-completely-including',
    'short',
    '关闭主界面即完全退出，Nomi 和托盘一起关闭。',
    'Closing the main window quits Nomi completely, including Nomi and the tray.',
  ],
  ['ui.mascot-theme.desktop-nomi', 'short', '桌面 Nomi', 'Desktop Nomi'],
  [
    'ui.mascot-theme.nomi-appears-on-your-desktop-first-click-her',
    'short',
    '桌面上先出现 Nomi，点它的「AI 对话」进入主界面（默认）',
    'Nomi appears on your desktop first; click its “AI chat” to open the main window (default)',
  ],
  [
    'ui.mascot-theme.nomi-is-closed-show-on-startup-has-been',
    'short',
    'Nomi 已关闭，启动后默认显示已改为「软件主界面」。',
    'Nomi is closed. “Show on startup” has been switched to Main window.',
  ],
  [
    'ui.mascot-theme.on-windows-linux-this-is-an-optional-top',
    'short',
    'Windows / Linux 上为可选的顶部胶囊；关闭时，Nomi 不在桌面时改用系统通知。',
    'On Windows / Linux this is an optional top pill; when off, system notifications are used while Nomi is closed.',
  ],
  [
    'ui.mascot-theme.only-the-main-window-closes-nomi-and-the',
    'short',
    '只关闭主界面，Nomi 和托盘继续运行（默认）。',
    'Only the main window closes; Nomi and the tray keep running (default).',
  ],
  [
    'ui.mascot-theme.open-the-main-window-right-after-launch-nomi',
    'short',
    '启动后直接打开主界面；Nomi 仍在桌面待命，定时任务和提醒照常播报。',
    'Open the main window right after launch; Nomi stays on your desktop and scheduled tasks and reminders are still announced.',
  ],
  [
    'ui.mascot-theme.open-the-main-window-right-away-nomi-waits',
    'short',
    '直接打开软件主界面，Nomi 在桌面待命',
    'Open the main window right away; Nomi waits on your desktop',
  ],
  ['ui.mascot-theme.open-with-nomi', 'short', '以 Nomi 方式打开', 'Open with Nomi'],
  ['ui.mascot-theme.show-nomi', 'short', '显示 Nomi', 'Show Nomi'],
  [
    'ui.mascot-theme.startup-mascot-first',
    'short',
    '桌面上先出现 Nomi，需要时点它的「AI 对话」进入主界面（默认）。',
    'Nomi appears on your desktop first; click its “AI chat” to open the main window when needed (default).',
  ],
  [
    'ui.mascot-theme.when-off-mascot-hidden-island-ok',
    'short',
    '关闭后 Nomi 从桌面隐藏、不再播放语音和监听唤醒词；提醒改由灵动岛送达（灵动岛不可用时用系统通知）。工具栏里的「关闭 Nomi」也会关掉这里，随时可在此重新打开。',
    'When off, Nomi is hidden from your desktop, no longer speaks and stops listening for the wake word; alerts go to the Dynamic Island instead (or a system notification if the island is unavailable). “Close Nomi” on the toolbar turns this off too — you can turn it back on here anytime.',
  ],
  [
    'ui.mascot-theme.when-off-nomi-is-hidden-from-your-desktop',
    'short',
    '关闭后 Nomi 从桌面隐藏、不再播放语音和监听唤醒词；启动后默认显示会自动改为「软件主界面」，保证随时能进入 Nomi。随时可在此重新打开。',
    'When off, Nomi is hidden from your desktop, no longer speaks and stops listening for the wake word. “Show on startup” switches to Main window automatically so you can always get into Nomi. Turn it back on here anytime.',
  ],
  ['ui.usage-tools.nomi-size', 'short', 'Nomi 大小', 'Nomi size'],
  ['ui.voice-mascot.chat-with-nomi', 'short', '与 Nomi 聊天', 'Chat with Nomi'],
  [
    'ui.voice-mascot.close-nomi-reopen-it-in-settings',
    'short',
    '关闭 Nomi（可在设置中重新打开）',
    'Close Nomi (reopen it in Settings)',
  ],
  [
    'ui.voice-mascot.couldn-t-close-nomi-please-try-again-later',
    'short',
    '关闭 Nomi 失败，请稍后再试',
    "Couldn't close Nomi. Please try again later.",
  ],
  ['ui.voice-mascot.nomi-panel', 'short', 'Nomi 功能面板', 'Nomi panel'],
  ['ui.voice-mascot.nomi-toolbar', 'short', 'Nomi 工具栏', 'Nomi toolbar'],
  // 2.0.5 是「你好，我是诺米，……」：单独的「诺米」改为简称
  [
    'ui.voice-mascot.preview-sentence',
    'short',
    '你好，我是 Nomi，今天也一起加油吧。',
    '你好，我是 Nomi，今天也一起加油吧。',
  ],
];

afterEach(() => applyLocale('zh-CN'));

describe('character-name copy with the official pack (docs/BRAND.md)', () => {
  it.each(CASES)('%s (%s name)', (key, which, zh, en) => {
    const names = which === 'full' ? FULL : SHORT;
    applyLocale('zh-CN');
    expect(tName(key, names.zh)).toBe(zh);
    applyLocale('en');
    expect(tName(key, names.en)).toBe(en);
  });

  it('the schedule preview keeps the spacing around the name', () => {
    applyLocale('zh-CN');
    expect(tName('ui.providers-schedule.nomi-says', 'Nomi', '早上好')).toBe('Nomi 说：「早上好」');
    expect(tName('ui.providers-schedule.nomi-says', '小纸', '早上好')).toBe('小纸说：「早上好」');
    applyLocale('en');
    expect(tName('ui.providers-schedule.nomi-says', 'Nomi', 'Hi')).toBe('Nomi says: “Hi”');
  });

  it('a Chinese stand-in name gets no extra spaces', () => {
    applyLocale('zh-CN');
    expect(tName('ui.mascot-theme.show-nomi', '小纸')).toBe('显示小纸');
    expect(tName('ui.usage-tools.nomi-size', '小纸')).toBe('小纸大小');
    expect(tName('ui.mascot-theme.welcome-title', '小纸')).toBe('你好，我是小纸');
  });

  it('no rendered zh string shows a bare 诺米', () => {
    applyLocale('zh-CN');
    for (const [key, which] of CASES) {
      const text = tName(key, which === 'full' ? FULL.zh : SHORT.zh);
      expect(text.replace(/Nomi·诺米/g, '')).not.toContain('诺米');
    }
  });
});

describe('spaceAround', () => {
  it.each([
    ['显示Ab', 'Ab', '显示 Ab'],
    ['Ab已隐藏', 'Ab', 'Ab 已隐藏'],
    ['我是Ab·小纸，你好', 'Ab·小纸', '我是 Ab·小纸，你好'],
    ['，Ab和托盘', 'Ab', '，Ab 和托盘'],
    ['关闭Ab（可以', 'Ab', '关闭 Ab（可以'],
    ['显示 Ab', 'Ab', '显示 Ab'],
    ['Show Ab', 'Ab', 'Show Ab'],
    ['显示小纸', '小纸', '显示小纸'],
    ['Ab 与Ab', 'Ab', 'Ab 与 Ab'],
    ['no name here', 'Ab', 'no name here'],
    ['显示v2', '', '显示v2'],
  ])('%s + %s → %s', (text, word, out) => {
    expect(spaceAround(text, word)).toBe(out);
  });
});
