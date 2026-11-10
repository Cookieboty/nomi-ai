import { useState } from 'react';

import { MarkdownEditHistory } from './markdownEditHistory';

/** Histories belong to open preview files, rather than either mounted editor. */
export function useMarkdownEditHistory(
  key: string,
  text: string,
  enabled: boolean,
  entries: readonly { key: string }[],
) {
  const [histories, setHistories] = useState(() => new Map<string, MarkdownEditHistory>());
  let next = histories;
  const open = new Set(entries.map((entry) => entry.key));
  for (const file of histories.keys()) {
    if (open.has(file)) continue;
    if (next === histories) next = new Map(histories);
    next.delete(file);
  }
  if (enabled) {
    const history = next.get(key);
    // A new disk snapshot must not revive undo records from an older file revision.
    if (!history || history.present.text !== text) {
      if (next === histories) next = new Map(histories);
      next.set(key, new MarkdownEditHistory(text));
    }
  }
  if (next !== histories) setHistories(next);
  return enabled ? next.get(key) : undefined;
}
