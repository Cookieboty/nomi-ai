import { act, waitFor } from '@testing-library/react';
import { expect } from 'vitest';

import { codeViewAt } from '../../src/components/ResourcePreview/codeViewModel';

export function sourceView(element: Element) {
  const view = codeViewAt(element);
  if (!view) throw new Error('Expected a mounted CodeMirror document');
  return view;
}
export function sourceValue(element: Element) {
  return sourceView(element).state.sliceDoc();
}
export function changeSource(element: Element, text: string) {
  const view = sourceView(element);
  act(() =>
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      userEvent: 'input',
    }),
  );
}
export function sourceEditable(element: Element) {
  return !sourceView(element).state.readOnly;
}
/** CodeMirror paints tokens incrementally; wait for the class rather than a fixed delay. */
export async function expectSourceToken(
  root: ParentNode | null,
  kind: 'keyword' | 'string',
  text: string,
) {
  await waitFor(() => expect(root?.querySelector(`.token.${kind}`)?.textContent).toBe(text));
}
