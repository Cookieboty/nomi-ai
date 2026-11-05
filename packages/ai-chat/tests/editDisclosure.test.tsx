// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { ConversationView } from '../src/components/Conversation';
import type { HarnessTraceEvent } from '../src/services/harnessClient';

afterEach(cleanup);

describe('编辑和写入内容默认收起', () => {
  for (const name of ['Edit', 'Write']) {
    it(`${name} 完成后的 diff 只在主动展开后挂载`, () => {
      const trace: HarnessTraceEvent[] = [
        {
          type: 'tool',
          name,
          id: 'edit-1',
          status: 'start',
          at: 1,
          input: JSON.stringify({
            file_path: 'a.ts',
            old_string: 'before',
            new_string: 'after',
            content: 'after',
          }),
        },
        { type: 'tool', name, id: 'edit-1', status: 'done', at: 2, output: 'ok' },
      ];
      const r = render(
        <ConversationView
          phase="idle"
          messages={[
            { id: 'u', role: 'user', text: '修改文件', at: 0 },
            { id: 'a', role: 'assistant', text: '完成', at: 3, trace },
          ]}
        />,
      );
      const row = r.getByTestId('tool-row');
      expect(row.getAttribute('data-open')).toBe('false');
      expect(row.querySelector('[data-testid="tool-diff"]')).toBeNull();
      expect(row.textContent).not.toContain('after');
      fireEvent.click(row.querySelector('button')!);
      expect(row.getAttribute('data-open')).toBe('true');
      expect(row.textContent).toContain('after');
      fireEvent.click(row.querySelector('button')!);
      expect(row.getAttribute('data-open')).toBe('false');
    });
  }
});
