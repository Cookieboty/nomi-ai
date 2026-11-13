import { afterEach, describe, expect, it } from 'vitest';

import { selectionFill } from '../src/app/useSelectionActions';
import {
  joinReferenceDraft,
  splitReferenceDraft,
} from '../src/components/MessageInput/useReferenceDraft';
import { sideChatRequestMessages } from '../src/services/sideChat';
import {
  composeWithQuotes,
  normalizeQuoteText,
  QUOTE_MAX_CHARS,
  quoteExcerpt,
  quoteMarkdown,
  readQuoteBlock,
} from '../src/utils/selectionQuote';
import {
  closeSideChat,
  EMPTY_SIDE_TABS,
  isMaximized,
  openAgent,
  openSideChat,
  parseSideTabs,
  resolveActive,
  SIDE_CHAT_TAB,
  sideTabItems,
  toggleMaximized,
} from '../src/utils/sideTabs';

describe('selection quotes', () => {
  it('serializes a quote block with its source and reads it back', () => {
    const md = quoteMarkdown({ text: '第一行\n\n第三行  \n', source: 'Claude Code · 你说的' });
    expect(md).toBe('> [!quote] Claude Code · 你说的\n> 第一行\n>\n> 第三行');
    const read = readQuoteBlock(md.split('\n'), 0)!;
    expect(read.quote).toEqual({ text: '第一行\n\n第三行', source: 'Claude Code · 你说的' });
    expect(read.end).toBe(4);
    expect(readQuoteBlock(['> 普通引用', '> 第二行'], 0)).toBeNull();
  });

  it('truncates very long selections and makes short chip labels', () => {
    expect(normalizeQuoteText('x'.repeat(QUOTE_MAX_CHARS + 10))).toHaveLength(QUOTE_MAX_CHARS + 1);
    expect(quoteExcerpt('  一段   很长很长的选中文字，用来看胶囊上的短标签会不会截断  ')).toBe(
      '一段 很长很长的选中文字，用来看胶囊上的短标签会…',
    );
  });

  it('composes the side chat message with quotes first', () => {
    expect(composeWithQuotes([{ text: 'a', source: 's' }], ' 为什么？ ')).toBe(
      '> [!quote] s\n> a\n\n为什么？',
    );
    expect(composeWithQuotes([], 'hi')).toBe('hi');
  });
});

describe('composer quote chips (添加到对话)', () => {
  it('turns a quote block in the draft into a chip and keeps it when sending', () => {
    const fill = selectionFill({ text: '选中的话', source: '主会话' });
    const draft = `${fill}帮我解释一下`;
    const split = splitReferenceDraft(draft);
    expect(split.text).toBe('帮我解释一下');
    expect(split.references).toHaveLength(1);
    expect(split.references[0]!.quote).toEqual({ text: '选中的话', source: '主会话' });
    expect(split.references[0]!.label).toBe('选中的话');
    // 发出去的仍是完整的引用块 + 问题
    expect(joinReferenceDraft(split.references, split.text)).toBe(
      '> [!quote] 主会话\n> 选中的话\n\n帮我解释一下',
    );
  });

  it('mixes file links and quotes, separated so the quote does not swallow the link', () => {
    const file = '[a.ts:3-5](file:///w/a.ts:3-5)';
    const quote = quoteMarkdown({ text: 'q', source: 's' });
    const joined = joinReferenceDraft(
      [
        { href: 'file:///w/a.ts:3-5', label: 'a.ts:3-5', markdown: file },
        { href: 'quote:x', label: 'q', markdown: quote, quote: { text: 'q', source: 's' } },
      ],
      'text',
    );
    expect(joined).toBe(`${file}\n\n${quote}\n\ntext`);
    const back = splitReferenceDraft(joined);
    expect(back.text).toBe('text');
    expect(back.references.map((r) => !!r.quote)).toEqual([false, true]);
  });

  it('file selections are added as a file link (path + line range)', () => {
    expect(selectionFill({ text: 'x', source: 'a.ts:3-5', href: 'file:///w/a.ts:3-5' })).toBe(
      '[a.ts:3-5](file:///w/a.ts:3-5)\n\n',
    );
  });

  it('does not treat quote markers inside code fences as chips', () => {
    const draft = '```\n> [!quote] s\n> a\n```\n';
    expect(splitReferenceDraft(draft).references).toHaveLength(0);
  });
});

describe('side chat tab state', () => {
  const agent = { kind: 'nomi-task', taskId: 'k1' } as const;
  it('opens as a tab after agents and files, and is the active tab', () => {
    const s = openSideChat(openAgent(EMPTY_SIDE_TABS, agent));
    expect(resolveActive(s, true)).toBe(SIDE_CHAT_TAB);
    expect(sideTabItems(s, ['f1']).map((i) => i.kind)).toEqual(['agent', 'file', 'chat']);
    // 只有侧边聊天时也能铺满（双击）
    const only = toggleMaximized(openSideChat(EMPTY_SIDE_TABS), SIDE_CHAT_TAB);
    expect(isMaximized(only, false)).toBe(true);
    expect(sideTabItems(only, []).map((i) => i.key)).toEqual(['main', SIDE_CHAT_TAB]);
  });

  it('closing goes back to the last agent; the tab is never restored from storage', () => {
    const s = openSideChat(openAgent(EMPTY_SIDE_TABS, agent));
    const closed = closeSideChat(s);
    expect(closed.sideChat).toBe(false);
    expect(resolveActive(closed, false)).toBe('nomi-task:k1');
    const stored = parseSideTabs(JSON.parse(JSON.stringify(s)))!;
    expect(stored.sideChat).toBeUndefined();
    expect(resolveActive(stored, false)).toBe('nomi-task:k1');
  });
});

describe('side chat request', () => {
  it('sends Nomi system prompt, earlier turns (with their quotes) and the new question', () => {
    const msgs = sideChatRequestMessages(
      'You are Nomi',
      [
        { id: 'u1', role: 'user', text: '这是什么', quotes: [{ text: 'A', source: 's' }] },
        { id: 'a1', role: 'assistant', text: '是 A' },
        { id: 'a2', role: 'assistant', text: '', error: 'boom' },
      ],
      '再说说',
      [{ text: 'B', source: 't' }],
    );
    expect(msgs).toEqual([
      { role: 'system', content: 'You are Nomi' },
      { role: 'user', content: '> [!quote] s\n> A\n\n这是什么' },
      { role: 'assistant', content: '是 A' },
      { role: 'user', content: '> [!quote] t\n> B\n\n再说说' },
    ]);
  });
});

afterEach(() => undefined);
