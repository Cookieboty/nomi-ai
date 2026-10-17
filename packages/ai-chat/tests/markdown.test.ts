import { describe, expect, it } from 'vitest';

import {
  sanitizeHref,
  sanitizeImgSrc,
  urlTransform,
} from '../src/components/Conversation/Markdown.helpers';
import { splitMarkdownChunks } from '../src/utils/markdown';

describe('splitMarkdownChunks (incremental streaming)', () => {
  const doc = [
    '## 小结',
    '',
    '段落 **一**，含 `code`。',
    '',
    '- 条目一',
    '- 条目二',
    '',
    '```ts',
    'const x = 1;',
    '',
    'console.log(x);',
    '```',
    '',
    '1. 第一',
    '',
    '2. 第二',
    '',
    '> 引用一',
    '',
    '> 引用二',
    '',
    '尾段',
  ].join('\n');

  it('splits at safe boundaries only: never inside a fence, never between list items', () => {
    const chunks = splitMarkdownChunks(doc);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.some((c) => c.includes('const x = 1;\n\nconsole.log(x);'))).toBe(true);
    expect(chunks.some((c) => c.includes('1. 第一') && c.includes('2. 第二'))).toBe(true);
  });

  it('concatenating the chunks reproduces the input', () => {
    expect(splitMarkdownChunks(doc).join('\n')).toBe(doc.replace(/\r\n?/g, '\n'));
  });

  it('is prefix-stable while streaming: earlier chunks stop changing once a boundary has passed', () => {
    const full = splitMarkdownChunks(doc);
    for (let n = 40; n < doc.length; n += 17) {
      const part = splitMarkdownChunks(doc.slice(0, n));
      for (let i = 0; i < part.length - 1; i++) expect(part[i]).toBe(full[i]);
    }
  });

  it('handles unclosed fences and CRLF', () => {
    expect(splitMarkdownChunks('前文\n\n```bash\nnpm i\n\nnpm test')).toHaveLength(2);
    expect(splitMarkdownChunks('a\r\n\r\nb')).toEqual(['a\n', 'b']);
  });
});

describe('Markdown link / image sanitisation', () => {
  it('sanitizeHref accepts http/https/mailto only', () => {
    expect(sanitizeHref('https://a.dev/x')).toBe('https://a.dev/x');
    expect(sanitizeHref('http://a.dev')).toBe('http://a.dev');
    expect(sanitizeHref('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(sanitizeHref('javascript:alert(1)')).toBe('');
    expect(sanitizeHref('file:///etc/passwd')).toBe('');
    expect(sanitizeHref('data:text/html,x')).toBe('');
    expect(sanitizeHref('chat-asset://images/a.png')).toBe('');
    expect(sanitizeHref('')).toBe('');
  });

  it('sanitizeImgSrc accepts https / data:image / blob / chat-asset only', () => {
    expect(sanitizeImgSrc('https://cdn/x.png')).toBe('https://cdn/x.png');
    expect(sanitizeImgSrc('data:image/png;base64,AA==')).toBe('data:image/png;base64,AA==');
    expect(sanitizeImgSrc('blob:https://x/abc')).toBe('blob:https://x/abc');
    expect(sanitizeImgSrc('chat-asset://images/a.png')).toBe('chat-asset://images/a.png');
    expect(sanitizeImgSrc('http://cdn/x.png')).toBe('');
    expect(sanitizeImgSrc('file:///c:/evil.png')).toBe('');
    expect(sanitizeImgSrc('data:text/html,x')).toBe('');
    expect(sanitizeImgSrc('javascript:alert(1)')).toBe('');
    expect(sanitizeImgSrc('cdmodel://user/a.png')).toBe('');
  });

  it('urlTransform routes image/link checks by tagName', () => {
    expect(urlTransform('https://cdn/x.png', 'src', { tagName: 'img' })).toBe('https://cdn/x.png');
    expect(urlTransform('https://cdn/x.png', 'href', { tagName: 'a' })).toBe('https://cdn/x.png');
    expect(urlTransform('javascript:alert(1)', 'src', { tagName: 'img' })).toBe('');
    expect(urlTransform('javascript:alert(1)', 'href', { tagName: 'a' })).toBe('');
    expect(urlTransform('http://cdn/x.png', 'src', { tagName: 'img' })).toBe('');
    expect(urlTransform('http://a.dev', 'href', { tagName: 'a' })).toBe('http://a.dev');
  });
});
