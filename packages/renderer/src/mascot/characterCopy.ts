/**
 * Character copy (tips, greetings, timed lines) comes from the active character pack's
 * `locales/<lang>.json` → `lines`, not from the UI catalog: a different pack brings its own words.
 * Line ids are the stable voice clip ids, so a line and its prompt clip share one key.
 */
import { getLocale, t } from '@nomi-ai/ui';

import { getCharacterLocales } from './characterConfig';
import { CHARACTER_LINE_IDS } from './tips';

const PRIMARY = 'zh';

function lang(): string {
  return (getLocale() || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** Is `key` a character line id (as opposed to a UI catalog key or plain text)? */
export function isCharacterLine(key: string): boolean {
  return CHARACTER_LINE_IDS.has(key);
}

/** The active pack's text for a line id in the UI language (falls back to zh); undefined if absent. */
export function characterLine(key: string): string | undefined {
  const locales = getCharacterLocales();
  for (const l of [lang(), PRIMARY]) {
    const v = locales[l]?.lines?.[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

/**
 * Text to show / speak for a bubble entry: character lines come from the pack (empty when the
 * pack does not have that line), UI catalog keys are translated, plain text passes through.
 */
export function bubbleText(key: string): string {
  if (isCharacterLine(key)) return characterLine(key) ?? '';
  return t(key);
}

/** Keep only entries that resolve to some text (a pack may ship a subset of the lines). */
export function availableLines(keys: readonly string[]): string[] {
  return keys.filter((k) => !isCharacterLine(k) || characterLine(k) !== undefined);
}
