/**
 * Character copy (tips, greetings, timed lines) comes from the active character pack's
 * `locales/<lang>.json` → `lines`, not from the UI catalog: a different pack brings its own words.
 * Line ids are the stable voice clip ids, so a line and its prompt clip share one key.
 */
import { personaNames } from '@nomi-ai/character-contract';
import { getLocale, t } from '@nomi-ai/ui';

import { BUNDLED_PACK, getCharacterLocales, getOverlay } from './characterConfig';
import { CHARACTER_LINE_IDS } from './tips';

const PRIMARY = 'zh';

function lang(): string {
  return (getLocale() || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** Full and short name of the active character in the UI language. Overlay pack → bundled pack. */
function names(): { displayName: string; shortName: string } {
  const l = lang();
  const overlay = getOverlay();
  const full = overlay?.displayName;
  if (full) {
    const pick = (n: { zh: string; en: string }) => (l === 'en' ? n.en : n.zh) || n.zh;
    const displayName = pick(full);
    return {
      displayName,
      shortName: (overlay.shortName && pick(overlay.shortName)) || displayName,
    };
  }
  const zh = personaNames({
    displayName: BUNDLED_PACK.persona?.displayName || BUNDLED_PACK.id,
    ...(BUNDLED_PACK.persona?.shortName ? { shortName: BUNDLED_PACK.persona.shortName } : {}),
  });
  return l === 'en' ? personaNames(zh, BUNDLED_PACK.locales.en?.persona) : zh;
}

/**
 * The active character's short name in the UI language (§10.1, docs/BRAND.md): wherever the UI
 * names the figure on the desktop again ("Close X", "X toolbar"), never a hard-coded official name. Put it into a sentence with `tName` so zh spacing stays right.
 */
export function characterName(): string {
  return names().shortName;
}

/** The active character's full name (first mention, e.g. a welcome line). */
export function characterFullName(): string {
  return names().displayName;
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
