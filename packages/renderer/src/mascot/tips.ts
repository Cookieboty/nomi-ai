/**
 * 看板娘提示文案。本文件为 Nomi 原创内容，随项目以 MIT 许可发布。
 * （取代此前来自第三方项目、GPL-3.0 许可的 waifu-tips.json）
 */
export interface TipRule {
  selector: string;
  text: string[];
}

export const MOUSEOVER_TIPS: TipRule[] = [
  {
    selector: '#mascot-canvas',
    text: [
      'ui.voice-mascot.hm-need-something',
      'ui.voice-mascot.i-m-right-here',
      'ui.voice-mascot.want-to-chat-about-something',
      'ui.voice-mascot.stop-poking-i-ll-get-shy',
    ],
  },
  {
    selector: '#waifu-tool-ai-chat',
    text: [
      'ui.voice-mascot.open-the-chat-window-and-talk-to-me',
      'ui.voice-mascot.ask-me-anything',
    ],
  },
  {
    selector: '#waifu-tool-info',
    text: [
      'ui.voice-mascot.want-to-learn-about-this-project',
      'ui.voice-mascot.here-s-an-introduction-to-me',
    ],
  },
  { selector: '#waifu-tool-photo', text: ['ui.voice-mascot.taking-a-photo-i-m-ready'] },
  {
    selector: '#waifu-tool-voice-settings',
    text: ['ui.voice-mascot.voice-settings-are-here-right-click-to-fine'],
  },
  { selector: '#waifu-tool-motion', text: ['ui.voice-mascot.want-to-see-me-do-a-move-right'] },
  {
    selector: '#waifu-tool-close-mascot',
    text: ['ui.voice-mascot.want-me-to-step-away-you-can-bring'],
  },
  {
    selector: '#waifu-tool-quit',
    text: [
      'ui.voice-mascot.time-for-a-break-see-you-next-time',
      'ui.voice-mascot.come-back-soon-okay',
    ],
  },
];

export const IDLE_TIPS: string[] = [
  'ui.voice-mascot.rest-your-eyes-look-at-something-far-away',
  'ui.voice-mascot.have-some-water-and-stay-hydrated',
  'ui.voice-mascot.you-ve-been-sitting-a-while-get-up',
  'ui.voice-mascot.if-something-s-puzzling-you-toss-it-my',
  'ui.voice-mascot.thanks-for-your-hard-work-today',
];

/** 按小时段的问候（[起始小时, 结束小时]，闭区间）。 */
export const TIME_GREETINGS: Array<{ from: number; to: number; text: string }> = [
  { from: 5, to: 8, text: 'ui.voice-mascot.good-morning-a-new-day-begins' },
  { from: 9, to: 11, text: 'ui.voice-mascot.good-morning-time-to-focus' },
  { from: 12, to: 13, text: 'ui.voice-mascot.it-s-noon-remember-to-have-lunch' },
  { from: 14, to: 17, text: 'ui.voice-mascot.good-afternoon-a-cup-of-tea-to-perk' },
  { from: 18, to: 21, text: 'ui.voice-mascot.good-evening-how-was-your-day' },
  { from: 22, to: 23, text: 'ui.voice-mascot.it-s-late-get-some-rest-soon' },
  { from: 0, to: 4, text: 'ui.voice-mascot.still-up-this-late-your-health-comes-first' },
];

export const MESSAGES = {
  welcome: 'ui.voice-mascot.hi-i-m-your-desktop-companion',
  copy: 'ui.voice-mascot.copied-remember-to-credit-the-source',
  visibility: 'ui.voice-mascot.welcome-back',
};

export function greetingFor(hour: number): string {
  return TIME_GREETINGS.find((g) => hour >= g.from && hour <= g.to)?.text ?? MESSAGES.welcome;
}

/** 键盘关键词触发的台词（取代旧的固定语音 mp3）。由 TTS 朗读。 */
export const KEYWORD_LINES: Array<{ keywords: string[]; lines: string[] }> = [
  {
    keywords: ['function', 'def ', 'func '],
    lines: ['ui.voice-mascot.another-function-written', 'ui.voice-mascot.nice-function-name'],
  },
  { keywords: ['if'], lines: ['ui.voice-mascot.watch-out-for-edge-cases'] },
  { keywords: ['for', 'while'], lines: ['ui.voice-mascot.make-sure-that-loop-can-end'] },
  { keywords: ['catch'], lines: ['ui.voice-mascot.nice-error-handling'] },
  { keywords: ['await'], lines: ['ui.voice-mascot.awaiting-async'] },
  { keywords: ['todo'], lines: ['ui.voice-mascot.another-todo-added'] },
];

export const HOURLY_LINES: Array<{ from: number; to: number; lines: string[] }> =
  TIME_GREETINGS.map((g) => ({ from: g.from, to: g.to, lines: [g.text] }));
