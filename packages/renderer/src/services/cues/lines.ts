/**
 * 看板娘事件台词（原创中文，可爱简短）。多条随机；冷却由 MascotCueService 控制。
 * MIT with the project.
 */

export type CueEvent =
  | 'hover:face'
  | 'hover:skirt'
  | 'hover:hands'
  | 'wall'
  | 'release'
  | 'wave'
  | 'think'
  | 'happy'
  | 'angry'
  | 'greet'
  | 'sleep'
  | 'agent:done'
  | 'agent:fail'
  | 'agent:permission'
  | 'agent:running'
  | 'agent:stalled'
  | 'agent:waiting'
  | 'reminder'
  | 'focus'
  | 'pomodoro'
  | 'file:drop'
  | 'confirm'
  | 'celebrate'
  | 'sorry'
  | 'thumbs_up'
  | 'goodnight'
  | 'nod'
  | 'clap'
  | 'poke'
  | 'grab_extra';

export const CUE_LINES: Record<CueEvent, string[]> = {
  'hover:face': [],
  'hover:skirt': [],
  'hover:hands': [],
  wall: [],
  release: [],
  wave: [],
  think: ['ui.usage-tools.let-me-think', 'ui.cli-monitor.hmm-one-sec'],
  happy: [],
  angry: [],
  greet: [
    'ui.cli-monitor.i-m-here',
    'ui.cli-monitor.let-s-do-our-best-today',
    'ui.cli-monitor.hi-i-m-nomi',
  ],
  sleep: ['ui.cli-monitor.rest-early-okay'],
  'agent:done': [
    'ui.cli-monitor.task-done',
    'ui.cli-monitor.done-thumbs-up',
    'ui.usage-tools.this-round-is-finished',
  ],
  'agent:fail': [
    'ui.cli-monitor.oops-something-went-wrong',
    'ui.usage-tools.didn-t-work-try-again',
    'ui.cli-monitor.failed-but-don-t-give-up',
  ],
  'agent:permission': [
    'ui.usage-tools.need-you-to-confirm',
    'ui.cli-monitor.permission-is-waiting-for-you',
    'ui.usage-tools.please-allow-or-deny-in-chat',
  ],
  'agent:running': [],
  'agent:stalled': [
    'ui.cli-monitor.looks-stuck',
    'ui.cli-monitor.no-updates-for-a-while',
    'ui.usage-tools.want-to-check-on-it',
  ],
  'agent:waiting': [
    'ui.cli-monitor.waiting-for-your-reply',
    'ui.usage-tools.your-turn',
    'ui.cli-monitor.ready-awaiting-your-order',
  ],
  reminder: [
    'ui.cli-monitor.reminder-time',
    'ui.cli-monitor.ding-don-t-forget-this',
    'ui.cli-monitor.it-s-time',
  ],
  focus: [
    'ui.cli-monitor.focus-time',
    'ui.usage-tools.flow-mode-on',
    'ui.cli-monitor.you-ve-got-this-i-m-here',
  ],
  pomodoro: [
    'ui.cli-monitor.pomodoro-take-a-break',
    'ui.cli-monitor.beep-time-to-rest',
    'ui.cli-monitor.stand-up-and-stretch',
  ],
  'file:drop': [
    'ui.cli-monitor.got-the-file',
    'ui.cli-monitor.let-me-see-what-it-is',
    'ui.cli-monitor.you-dropped-it-i-ll-read-it',
  ],
  confirm: [
    'ui.usage-tools.please-confirm-this-action',
    'ui.usage-tools.confirm-before-we-continue',
    'ui.cli-monitor.i-ll-wait-for-your-yes',
  ],
  celebrate: ['ui.cli-monitor.awesome', 'ui.cli-monitor.success-confetti'],
  sorry: ['ui.cli-monitor.i-ll-fix-it-right-away'],
  thumbs_up: ['ui.cli-monitor.well-done'],
  goodnight: [
    'ui.cli-monitor.good-night-sweet-dreams',
    'ui.cli-monitor.it-s-late-rest-a-bit',
    'ui.cli-monitor.see-you-tomorrow',
  ],
  nod: ['ui.cli-monitor.okay', 'ui.cli-monitor.got-it'],
  clap: [],
  poke: [],
  grab_extra: [],
};

/** 事件默认冷却（ms）与语音优先级（高可打断低） */
export const CUE_META: Record<CueEvent, { cooldownMs: number; priority: number; sfx?: string }> = {
  'hover:face': { cooldownMs: 8000, priority: 1, sfx: 'hum' },
  'hover:skirt': { cooldownMs: 8000, priority: 1, sfx: 'hum' },
  'hover:hands': { cooldownMs: 8000, priority: 1, sfx: 'pop' },
  wall: { cooldownMs: 4000, priority: 2, sfx: 'land' },
  release: { cooldownMs: 2500, priority: 2, sfx: 'pop' },
  wave: { cooldownMs: 5000, priority: 2, sfx: 'wave' },
  think: { cooldownMs: 6000, priority: 2, sfx: 'think' },
  happy: { cooldownMs: 5000, priority: 2, sfx: 'ding' },
  angry: { cooldownMs: 5000, priority: 2, sfx: 'hum' },
  greet: { cooldownMs: 30_000, priority: 2, sfx: 'wave' },
  sleep: { cooldownMs: 60_000, priority: 1, sfx: 'hum' },
  'agent:done': { cooldownMs: 8000, priority: 4, sfx: 'success' },
  'agent:fail': { cooldownMs: 8000, priority: 4, sfx: 'fail' },
  'agent:permission': { cooldownMs: 5000, priority: 5, sfx: 'ding' },
  'agent:running': { cooldownMs: 45_000, priority: 2, sfx: 'think' },
  'agent:stalled': { cooldownMs: 60_000, priority: 3, sfx: 'hum' },
  'agent:waiting': { cooldownMs: 30_000, priority: 3, sfx: 'ding' },
  reminder: { cooldownMs: 2000, priority: 5, sfx: 'ding' },
  focus: { cooldownMs: 30_000, priority: 3, sfx: 'ding' },
  pomodoro: { cooldownMs: 10_000, priority: 4, sfx: 'ding' },
  'file:drop': { cooldownMs: 3000, priority: 3, sfx: 'swoosh' },
  confirm: { cooldownMs: 4000, priority: 4, sfx: 'think' },
  celebrate: { cooldownMs: 5000, priority: 3, sfx: 'success' },
  sorry: { cooldownMs: 5000, priority: 3, sfx: 'fail' },
  thumbs_up: { cooldownMs: 5000, priority: 3, sfx: 'pop' },
  goodnight: { cooldownMs: 60_000, priority: 2, sfx: 'hum' },
  nod: { cooldownMs: 4000, priority: 1, sfx: 'click' },
  clap: { cooldownMs: 4000, priority: 2, sfx: 'pop' },
  poke: { cooldownMs: 2000, priority: 2, sfx: 'pop' },
  grab_extra: { cooldownMs: 3000, priority: 2, sfx: 'swoosh' },
};

/** Reaction kinds already spoken in reactions.ts — bridge plays SFX only. */
export const REACTION_SPEAK_KINDS = new Set(['click', 'double', 'pat', 'land', 'grab']);
