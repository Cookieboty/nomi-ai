// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';

import { TITLEBAR_MENU_GAP, titlebarMenuTop } from '../src/utils/titlebarMenu';

const rect = (top: number, bottom: number) => ({ top, bottom }) as DOMRect;

afterEach(() => {
  document.body.innerHTML = '';
});

describe('titlebarMenuTop', () => {
  it('keeps the menu off the chat card top edge, like the session details float', () => {
    const card = document.createElement('div');
    card.dataset.testid = 'workspace-card';
    card.getBoundingClientRect = () => rect(40, 800);
    document.body.appendChild(card);
    // 按钮底边 34：按钮下方 4px 会贴着卡片顶边，改为卡片顶边下方 12px
    expect(titlebarMenuTop(rect(6, 34))).toBe(40 + TITLEBAR_MENU_GAP);
  });

  it('without a chat card, keeps the same gap below the button', () => {
    expect(titlebarMenuTop(rect(6, 34))).toBe(34 + TITLEBAR_MENU_GAP);
  });
});
