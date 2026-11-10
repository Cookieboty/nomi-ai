/**
 * 文档全屏时对话收成的圆形按钮：对话列是 inline-size 容器（App.css `.chat-column { container: … / inline-size }`），
 * 宽度不能靠内容撑开——写成 width: auto 时按钮宽度是 0、整个看不见。happy-dom 不排版，这里守住样式本身。
 */
import fs from 'node:fs';

import { repoPath } from '@nomi-ai/repo-paths';
import { describe, expect, it } from 'vitest';

const css = fs.readFileSync(repoPath('packages/ai-chat/src/App.css'), 'utf8');

describe('preview chat button css', () => {
  it('gives the minimized column a fixed size and turns off its size container', () => {
    const rule = css.match(
      /\.main-content--resource-expanded > \.chat-column\[data-preview-chat-min\] \{([^}]*)\}/,
    )?.[1];
    expect(rule).toBeTruthy();
    expect(rule).toMatch(/container-type:\s*normal/);
    expect(rule).toMatch(/width:\s*[\d.]+rem\s*!important/);
    expect(rule).toMatch(/height:\s*[\d.]+rem/);
    expect(rule).not.toMatch(/width:\s*auto/);
  });
});
