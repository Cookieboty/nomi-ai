// @vitest-environment happy-dom
/** Nomi 生图工具（image_generate）的结果：图片直接显示在这一步下面 */
import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { generatedImageOf, ToolCallRow } from '../src/components/Conversation/ToolTimeline';
import type { ToolCall } from '../src/utils/toolTrace';

const call = (o: Partial<ToolCall> = {}): ToolCall => ({
  id: 'c1',
  name: 'image_generate',
  status: 'done',
  input: JSON.stringify({ prompt: 'a red fox' }),
  output: JSON.stringify({
    ok: true,
    image: 'chat-asset://images/nomi-abc-123.png',
    model: 'openai/gpt-image-2',
    provider: 'amux',
    auto: true,
  }),
  ...o,
});

afterEach(cleanup);

describe('生图结果', () => {
  it('完成后在这一步下面显示图片，alt 是提示词', () => {
    const r = render(<ToolCallRow call={call()} />);
    const img = r.getByTestId('tool-generated-image').querySelector('img')!;
    expect(img.getAttribute('src')).toContain('images/nomi-abc-123.png');
    expect(img.getAttribute('alt')).toBe('a red fox');
    // 图片下面写明由哪个模型生成，自动匹配的标出来，悬停看完整的「供应商/模型」
    const cap = r.getByTestId('tool-generated-model');
    expect(cap.textContent).toContain('由 gpt-image-2 生成');
    expect(cap.textContent).toContain('自动匹配');
  });

  it('运行中 / 失败 / 别的工具：不显示', () => {
    expect(generatedImageOf(call({ status: 'running' }))).toBeNull();
    expect(generatedImageOf(call({ status: 'error', output: 'boom' }))).toBeNull();
    expect(generatedImageOf(call({ name: 'fs_read' }))).toBeNull();
    const r = render(<ToolCallRow call={call({ status: 'error', output: 'boom' })} />);
    expect(r.queryByTestId('tool-generated-image')).toBeNull();
  });
});
