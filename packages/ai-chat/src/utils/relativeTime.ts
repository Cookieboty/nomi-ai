import { getLocale } from '@nomi-ai/ui';

const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 30],
  ['month', 12],
  ['year', Infinity],
];

/** 「2 分钟前」「1 小时前」：跟界面语言走（不到一分钟写「现在」） */
export function fmtAgo(ms: number, now = Date.now()): string {
  const rtf = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'auto' });
  let v = Math.round((ms - now) / 1000);
  if (Math.abs(v) < 60) return rtf.format(0, 'second');
  for (const [unit, size] of STEPS) {
    if (Math.abs(v) < size) return rtf.format(v, unit);
    v = Math.round(v / size);
  }
  return rtf.format(v, 'year');
}
