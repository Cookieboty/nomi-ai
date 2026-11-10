// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React, { useState } from 'react';
import { afterEach, expect, it } from 'vitest';

import { McpHeaderRows } from '../src/components/ExtensionsPanel/McpHeaderRows';

afterEach(cleanup);
it('edits header rows without losing equals signs and synchronizes the existing text draft', () => {
  function Form() {
    const [value, setValue] = useState('Authorization=Bearer abc==\nX-Region=us');
    return (
      <>
        <McpHeaderRows value={value} onChange={setValue} />
        <output data-testid="headers-value">{value}</output>
      </>
    );
  }
  render(<Form />);
  expect((screen.getByTestId('mcp-header-value-0') as HTMLInputElement).value).toBe('Bearer abc==');
  fireEvent.change(screen.getByTestId('mcp-header-value-1'), { target: { value: 'cn' } });
  fireEvent.click(screen.getByTestId('mcp-header-add'));
  fireEvent.change(screen.getByTestId('mcp-header-key-2'), { target: { value: 'X-Extra' } });
  fireEvent.change(screen.getByTestId('mcp-header-value-2'), { target: { value: 'a=b' } });
  fireEvent.click(screen.getByTestId('mcp-header-remove-1'));
  expect(screen.getByTestId('headers-value').textContent).toBe(
    'Authorization=Bearer abc==\nX-Extra=a=b',
  );
});
