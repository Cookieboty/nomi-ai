import { afterEach, describe, expect, it } from 'vitest';

import { selectionFill } from '../src/app/useSelectionActions';
import {
  joinReferenceDraft,
  splitReferenceDraft,
} from '../src/components/MessageInput/useReferenceDraft';
import { sideChatRequestMessages } from '../src/services/sideChat';
import {
  normalizeQuoteText,
  QUOTE_MAX_CHARS,
  quoteExcerpt,
  quoteMarkdown,
  readQuoteBlock,
} from '../src/utils/selectionQuote';
import {
  EMPTY_SIDE_TABS,
  isMaximized,
  isSideChatKey,
  openAgent,
  parseSideTabs,
  resolveActive,
  sideTabItems,
  toggleMaximized,
  withoutSideChats,
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
  const chat = (chatId: string) => ({ kind: 'side-chat', chatId }) as const;
  it('several side chats are ordinary agent tabs (keys, order, maximize)', () => {
    let s = openAgent(EMPTY_SIDE_TABS, agent);
    s = openAgent(s, chat('a'));
    s = openAgent(s, chat('b'));
    expect(resolveActive(s, true)).toBe('side-chat:b');
    expect(sideTabItems(s, ['f1']).map((i) => i.key)).toEqual([
      'nomi-task:k1',
      'side-chat:a',
      'side-chat:b',
      'file:f1',
    ]);
    expect(isSideChatKey('side-chat:a')).toBe(true);
    expect(isSideChatKey('nomi-task:k1')).toBe(false);
    const only = toggleMaximized(openAgent(EMPTY_SIDE_TABS, chat('a')), 'side-chat:a');
    expect(isMaximized(only, false)).toBe(true);
    // 再开同一个只是切过去
    expect(openAgent(s, chat('a')).agents).toHaveLength(3);
  });

  it('side chats are never written to storage (content is memory only)', () => {
    let s = openAgent(EMPTY_SIDE_TABS, agent);
    s = openAgent(s, chat('a'));
    s = { ...s, order: ['side-chat:a', 'nomi-task:k1'] };
    const kept = withoutSideChats(s);
    expect(kept.agents).toEqual([agent]);
    expect(kept.order).toEqual(['nomi-task:k1']);
    expect(kept.active).toBeNull();
    expect(resolveActive(kept, false)).toBe('nomi-task:k1');
    // 读回来时也不认侧边聊天
    expect(parseSideTabs(JSON.parse(JSON.stringify(s)))!.agents).toEqual([agent]);
    expect(withoutSideChats(kept)).toBe(kept);
  });
});

describe('side chat request', () => {
  it('sends Nomi system prompt, earlier turns (images as a note) and the new question with images', () => {
    const img = { mime: 'image/png', thumb: 'data:t', width: 1, height: 1 };
    const msgs = sideChatRequestMessages(
      'You are Nomi',
      [
        { id: 'u1', role: 'user', text: '这是什么', raw: { images: [img] } },
        { id: 'a1', role: 'assistant', text: '是 A' },
        { id: 'a2', role: 'assistant', text: '', error: 'boom' },
      ],
      { id: 'u2', role: 'user', text: '再说说', raw: { images: [{ ...img, data: 'AAA' }] } },
    );
    expect(msgs[0]).toEqual({ role: 'system', content: 'You are Nomi' });
    expect(msgs[1]!.role).toBe('user');
    expect(msgs[1]!.content.endsWith('这是什么')).toBe(true);
    expect(msgs[1]!.content.length).toBeGreaterThan('这是什么'.length);
    expect(msgs[1]).not.toHaveProperty('images');
    expect(msgs[2]).toEqual({ role: 'assistant', content: '是 A' });
    expect(msgs[3]).toEqual({
      role: 'user',
      content: '再说说',
      images: [{ mime: 'image/png', data: 'AAA' }],
    });
    expect(msgs).toHaveLength(4);
  });
});

afterEach(() => undefined);
