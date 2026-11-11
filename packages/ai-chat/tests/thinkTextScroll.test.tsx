// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { ThinkText } from '../src/components/Conversation/ToolTimeline';

afterEach(cleanup);

/** happy-dom 不排版：给内容区一个固定的可视高度与随内容变化的总高度 */
function fakeLayout(el: HTMLElement, height: () => number) {
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 240 });
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: height });
}

describe('思考正文跟随到底', () => {
  it('思考进行中：新内容追加后滚到最新一行；往上翻就不再跟随，翻回底部后恢复', () => {
    let h = 400;
    const r = render(<ThinkText text="a" running />);
    const el = r.getByTestId('tool-thinking-text');
    fakeLayout(el, () => h);
    h = 600;
    r.rerender(<ThinkText text="ab" running />);
    expect(el.scrollTop).toBe(600);

    // 用户往上翻：不再跟随
    el.scrollTop = 100;
    fireEvent.scroll(el);
    h = 800;
    r.rerender(<ThinkText text="abc" running />);
    expect(el.scrollTop).toBe(100);

    // 翻回底部：恢复跟随
    el.scrollTop = 800 - 240;
    fireEvent.scroll(el);
    h = 1000;
    r.rerender(<ThinkText text="abcd" running />);
    expect(el.scrollTop).toBe(1000);
  });

  it('思考结束后不再自动滚动', () => {
    let h = 400;
    const r = render(<ThinkText text="a" running={false} />);
    const el = r.getByTestId('tool-thinking-text');
    fakeLayout(el, () => h);
    h = 600;
    r.rerender(<ThinkText text="ab" running={false} />);
    expect(el.scrollTop).toBe(0);
  });
});
