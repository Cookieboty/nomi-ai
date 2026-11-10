import { act } from '@testing-library/react';

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
