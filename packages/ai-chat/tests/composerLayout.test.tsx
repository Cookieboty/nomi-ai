// @vitest-environment happy-dom
/**
 * 输入框底部工具栏布局约束（真实像素级断言见 e2e-headed/tests/E28.input-layout.headed.spec.ts；
 * happy-dom 没有布局，这里锁住"结构 + CSS 契约"，防止有人把它改回 flex-wrap 导致发送按钮掉到第二行）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessageInput } from '../src/components/MessageInput';

vi.mock('../src/contexts/AiChatContext', () => ({
  useAiChat: () => ({
    state: { messages: [], isLoading: false, streaming: false },
    actions: { stopGeneration: vi.fn(), sendStreamMessage: vi.fn(), askKnowledge: vi.fn() },
  }),
}));

afterEach(cleanup);

const css = readFileSync(
  resolve(__dirname, '../src/components/MessageInput/index.module.css'),
  'utf8',
);

/** 取 `selector { ... }` 的第一个规则体（selector 必须是整行选择器） */
const rule = (selector: string): string => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`).exec(css);
  if (!m) throw new Error(`rule not found: ${selector}`);
  return m[1];
};

describe('输入框工具栏结构', () => {
  it('发送按钮与语音按钮在右侧按钮组，插件入口在左侧区，两者同在 composer-bar 里', () => {
    const { getByTestId } = render(<MessageInput onSend={vi.fn()} onPluginsClick={vi.fn()} />);
    const bar = getByTestId('composer-bar');
    const left = bar.querySelector('[data-zone="left"]');
    const right = bar.querySelector('[data-zone="right"]');
    expect(left).toBeTruthy();
    expect(right).toBeTruthy();
    expect(left?.nextElementSibling).toBe(right);
    expect(right?.contains(getByTestId('send-button'))).toBe(true);
    expect(left?.contains(getByTestId('composer-more'))).toBe(true);
    expect(left?.contains(getByTestId('plugin-panel-open'))).toBe(true);
    expect(left?.contains(getByTestId('send-button'))).toBe(false);
  });
});

describe('输入框工具栏 CSS 契约', () => {
  it('工具栏不换行；右侧按钮组不收缩；左侧区可收缩（min-width:0）', () => {
    const bar = rule('.composerBar');
    expect(bar).toMatch(/flex-wrap:\s*nowrap/);
    expect(bar).not.toMatch(/flex-wrap:\s*wrap\b/);
    expect(rule('.composerRight')).toMatch(/flex:\s*none/);
    const left = rule('.composerLeft');
    expect(left).toMatch(/min-width:\s*0/);
    expect(left).toMatch(/flex:\s*1 1 0/);
  });

  it('发送按钮永不收缩；选择器区按工具栏宽度折叠', () => {
    expect(rule('.sendButton')).toMatch(/flex-shrink:\s*0/);
    expect(rule('.composerBar')).toMatch(/container-type:\s*inline-size/);
    expect(css).toMatch(/@container composer \(max-width: \d+px\)/);
  });

  it('选择器区溢出时省略而不是撑开：overflow hidden + min-width 0', () => {
    const body = /\.composerBar \.modelStatus \{([^}]*)\}\s*\.composerBar \.modelStatus >/.exec(
      css,
    );
    expect(body?.[1]).toMatch(/overflow:\s*hidden/);
    expect(body?.[1]).toMatch(/flex:\s*1 1 0/);
  });

  // #71（E28 Windows 720px）：选择器区里的胶囊按钮必须自己收缩，否则 nowrap 的按钮会越过右侧语音按钮、
  // 被 modelStatus 裁掉。新加的按钮（如「模型 · 思考深度」）也要满足同一契约。
  it.each(['PermissionModeChip', 'ModelControls'])(
    '%s：按钮可收缩（省略号），极窄输入栏只留图标',
    (name) => {
      const chipCss = readFileSync(
        resolve(__dirname, `../src/components/${name}/index.module.css`),
        'utf8',
      );
      const body = (sel: string) => new RegExp(`\\n${sel} \\{([^}]*)\\}`).exec(chipCss)?.[1] ?? '';
      expect(body('\\.wrap')).toMatch(/min-width:\s*0/);
      expect(body('\\.chip')).toMatch(/min-width:\s*0/);
      expect(body('\\.chip')).toMatch(/overflow:\s*hidden/);
      expect(body('\\.label')).toMatch(/text-overflow:\s*ellipsis/);
      expect(chipCss).toMatch(
        /@container composer \(max-width: 440px\)\s*\{\s*\.label\s*\{\s*display:\s*none;/,
      );
    },
  );
});
