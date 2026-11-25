// 错误提示卡片宽度契约：在 chatview 输入区中必须与消息列、输入框（--cd-chat-content-w）同宽居中，
// 不能在 .messageInputContainer（align-items: stretch）下横向拉满整列导致溢出。
// happy-dom 不做布局计算，这里对 CSS 源码做契约断言（与 emptyChatCentering.test.ts 同一手法）。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(resolve(__dirname, '..', rel), 'utf8');
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const errorHintCss = stripComments(read('src/components/ErrorHint/index.module.css'));
const messageInputCss = stripComments(read('src/components/MessageInput/index.module.css'));

function ruleBody(css: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&');
  const re = new RegExp(`(?:^|[}/])\\s*${esc}\\s*\\{([^}]*)\\}`, 'g');
  const all = [...css.matchAll(re)].map((m) => m[1] ?? '');
  expect(all.length, `找不到规则 ${selector}`).toBeGreaterThan(0);
  return all.join('\n');
}

describe('ErrorHint 宽度契约：与聊天内容列对齐不溢出', () => {
  it('.errorHint 与 .inputWrapper 使用相同的聊天内容列限宽与居中规则', () => {
    const hint = ruleBody(errorHintCss, '.errorHint');
    const wrapper = ruleBody(messageInputCss, '.inputWrapper');

    expect(wrapper).toMatch(/max-width:\s*var\(--cd-chat-content-w\)/);

    expect(hint).toMatch(/(?:^|[;\s])width:\s*100%/);
    expect(hint).toMatch(/(?:^|[;\s])max-width:\s*var\(--cd-chat-content-w\)/);
    expect(hint).toMatch(/(?:^|[;\s])min-width:\s*0/);
    expect(hint).toMatch(/(?:^|[;\s])box-sizing:\s*border-box/);
    expect(hint).toMatch(/(?:^|[;\s])margin:\s*0\s+auto(?:\s+[^;]+)?;/);
  });

  it('.errorHintTitle 与 .errorHintDesc 允许任意位置换行并收缩，避免长错误信息撑破列宽', () => {
    const title = ruleBody(errorHintCss, '.errorHintTitle');
    const desc = ruleBody(errorHintCss, '.errorHintDesc');

    expect(title).toMatch(/(?:^|[;\s])min-width:\s*0/);
    expect(title).toMatch(/(?:^|[;\s])overflow-wrap:\s*anywhere/);
    expect(desc).toMatch(/(?:^|[;\s])min-width:\s*0/);
    expect(desc).toMatch(/(?:^|[;\s])overflow-wrap:\s*anywhere/);
  });
});
