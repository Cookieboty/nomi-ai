import { t } from '@nomi-ai/ui';

import { splitFileAttachments } from './fileAttachments';

export const TITLE_MAX = 40;
export const HEURISTIC_MAX = 30;

const pending = new Set<string>();

export function isDefaultChatName(name: string): boolean {
  return name === 'ui.chat-settings.new-chat' || name === t('ui.chat-settings.new-chat');
}

export function heuristicTitle(raw: string, max = HEURISTIC_MAX): string {
  return splitFileAttachments(raw).text.replace(/\s+/g, ' ').trim().slice(0, max);
}

export function sanitizeSmartTitle(raw: string, max = TITLE_MAX): string | null {
  let s = raw.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith('“') && s.endsWith('”')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/[。.!！?？]+$/u, '').trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

export function buildTitleMessages(userText: string) {
  const body = userText.replace(/\s+/g, ' ').trim().slice(0, 500);
  return [
    {
      role: 'system' as const,
      content:
        'You name chat sessions. Reply with a concise title only: ≤40 characters, no quotes, no trailing punctuation, same language as the user.',
    },
    { role: 'user' as const, content: body },
  ];
}

export type TitleComplete = (
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
) => Promise<string>;

export async function generateSmartTitle(
  userText: string,
  complete: TitleComplete,
): Promise<string | null> {
  const cleaned = heuristicTitle(userText, 500);
  if (!cleaned) return null;
  try {
    const raw = await complete(buildTitleMessages(cleaned));
    return sanitizeSmartTitle(typeof raw === 'string' ? raw : '');
  } catch {
    return null;
  }
}

export function armNomiAutoTitle(id: string): void {
  pending.add(id);
}

export function clearNomiAutoTitle(id: string): void {
  pending.delete(id);
}

export function nomiAutoTitlePending(id: string): boolean {
  return pending.has(id);
}
