// 层级契约：输入区（含向上弹出的斜杠面板 / 下拉菜单）必须高于聊天内容。
// 回归：聊天背景功能给 `.chat-container > *` 加了 z-index:1，而 `.input-container`
// 没有 z-index（backdrop-filter 使其成为 z=0 的层叠上下文），导致输入区里 z-index:50 的
// 斜杠面板整体被消息文字压住（mac 上看起来像"面板半透明、文字叠在一起"）。
// happy-dom 不做层叠计算，这里只能对 CSS 源码做契约断言；真实绘制顺序见 PR 说明里的 headless Chromium 验证。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(resolve(__dirname, '..', rel), 'utf8');
const app = read('src/App.css');
const tokens = readFileSync(resolve(__dirname, '../../ui/src/tokens.css'), 'utf8');

/** 取某个选择器（精确匹配整段选择器）的最后一个规则体 */
function ruleBody(css: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&');
  const re = new RegExp(`(?:^|[}/])\\s*${esc}\\s*\\{([^}]*)\\}`, 'g');
  const all = [...css.matchAll(re)].map((m) => m[1] ?? '');
  expect(all.length, `找不到规则 ${selector}`).toBeGreaterThan(0);
  return all.join('\n');
}
const token = (name: string) => Number(new RegExp(`${name}:\\s*(\\d+)`).exec(tokens)?.[1]);

describe('聊天区层级：输入区高于聊天内容', () => {
  it('z-index token 存在且输入区 > 聊天内容', () => {
    expect(token('--cd-z-chat-content')).toBeGreaterThan(0);
    expect(token('--cd-z-chat-input')).toBeGreaterThan(token('--cd-z-chat-content'));
  });

  it('.chat-container > 内容用 content token，.input-container 定位 + 用 input token', () => {
    const content = ruleBody(app, '.chat-container > *');
    expect(content).toMatch(/position:\s*relative/);
    expect(content).toMatch(/z-index:\s*var\(--cd-z-chat-content/);
    const input = ruleBody(app, '.input-container');
    expect(input).toMatch(/position:\s*relative/);
    expect(input).toMatch(/z-index:\s*var\(--cd-z-chat-input/);
  });

  it('.chat-container 自成层叠上下文（isolation），背景层 z-index 不外溢', () => {
    expect(ruleBody(app, '.chat-container')).toMatch(/isolation:\s*isolate/);
  });

  it('斜杠面板用不透明的弹层背景（surface-raised），不是 transparent / 半透明字面量', () => {
    const palette = readFileSync(
      resolve(__dirname, '../src/components/SlashPalette/index.module.css'),
      'utf8',
    );
    const menu = ruleBody(palette, '.menu');
    expect(menu).toMatch(/background:\s*var\(--cd-color-surface-raised/);
    expect(menu).not.toMatch(/background:\s*(transparent|rgba)/);
    expect(menu).toMatch(/position:\s*absolute/);
  });
});
