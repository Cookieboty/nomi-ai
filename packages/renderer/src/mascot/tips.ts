/**
 * When the mascot says what: hover tips, idle tips, timed greetings. The entries are character
 * line ids (stable voice clip ids); the words themselves live in the active character pack's
 * `locales/<lang>.json` (see ./characterCopy.ts). A pack without a line simply stays quiet there.
 */
export interface TipRule {
  selector: string;
  text: string[];
}

export const MOUSEOVER_TIPS: TipRule[] = [
  { selector: '#mascot-canvas', text: ['tip-want-to-chat-about-something'] },
  {
    selector: '#companion-tool-ai-chat',
    text: ['tip-open-the-chat-window-and-talk-to-me', 'tip-ask-me-anything'],
  },
  {
    selector: '#companion-tool-voice-settings',
    text: ['tip-voice-settings-are-here-right-click-to-fine'],
  },
  { selector: '#companion-tool-motion', text: ['tip-want-to-see-me-do-a-move-right'] },
  { selector: '#companion-tool-close-mascot', text: ['tip-want-me-to-step-away-you-can-bring'] },
  {
    selector: '#companion-tool-quit',
    text: ['tip-time-for-a-break-see-you-next-time', 'tip-come-back-soon-okay'],
  },
];

export const IDLE_TIPS: string[] = [
  'tip-rest-your-eyes-look-at-something-far-away',
  'tip-have-some-water-and-stay-hydrated',
  'tip-you-ve-been-sitting-a-while-get-up',
  'tip-if-something-s-puzzling-you-toss-it-my',
  'tip-thanks-for-your-hard-work-today',
];

/** 按小时段的问候（[起始小时, 结束小时]，闭区间）。 */
export const TIME_GREETINGS: Array<{ from: number; to: number; text: string }> = [
  { from: 5, to: 8, text: 'time-good-morning-a-new-day-begins' },
  { from: 9, to: 11, text: 'time-good-morning-time-to-focus' },
  { from: 12, to: 13, text: 'time-it-s-noon-remember-to-have-lunch' },
  { from: 14, to: 17, text: 'time-good-afternoon-a-cup-of-tea-to-perk' },
  { from: 18, to: 21, text: 'time-good-evening-how-was-your-day' },
  { from: 22, to: 23, text: 'time-it-s-late-get-some-rest-soon' },
  { from: 0, to: 4, text: 'time-still-up-this-late-your-health-comes-first' },
];

export const MESSAGES = {
  welcome: 'greet-companion',
  visibility: 'greet-welcome-back',
};

export function greetingFor(hour: number): string {
  return TIME_GREETINGS.find((g) => hour >= g.from && hour <= g.to)?.text ?? MESSAGES.welcome;
}

export const HOURLY_LINES: Array<{ from: number; to: number; lines: string[] }> =
  TIME_GREETINGS.map((g) => ({ from: g.from, to: g.to, lines: [g.text] }));

/** Every line id above: these are looked up in the character pack, never in the UI catalog. */
export const CHARACTER_LINE_IDS: ReadonlySet<string> = new Set([
  ...MOUSEOVER_TIPS.flatMap((r) => r.text),
  ...IDLE_TIPS,
  ...TIME_GREETINGS.map((g) => g.text),
  ...Object.values(MESSAGES),
]);
