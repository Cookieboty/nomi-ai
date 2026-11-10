import { StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';

import type { TextMatch } from './fileFindIndex';

export function codeViewAt(root: Element | null | undefined): EditorView | null {
  const editor =
    root?.closest<HTMLElement>('.cm-editor') ?? root?.querySelector<HTMLElement>('.cm-editor');
  return editor ? EditorView.findFromDOM(editor) : null;
}
export function revealCodeLine(view: EditorView, number: number) {
  const line = view.state.doc.line(Math.min(view.state.doc.lines, Math.max(1, number)));
  view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'start' }) });
}
export const codeFindEffect = StateEffect.define<{
  matches: readonly TextMatch[];
  current: number;
}>();
const emptyFind = { matches: [] as readonly TextMatch[], current: -1 };
const findState = StateField.define({
  create: () => emptyFind,
  update(value, transaction) {
    if (transaction.docChanged) value = emptyFind;
    for (const effect of transaction.effects) if (effect.is(codeFindEffect)) value = effect.value;
    return value;
  },
});
function visibleMatches(view: EditorView) {
  const { matches, current } = view.state.field(findState);
  const marks = [];
  for (const visible of view.visibleRanges) {
    let low = 0,
      high = matches.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (matches[middle]!.end <= visible.from) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < matches.length; index++) {
      const match = matches[index]!;
      if (match.start >= visible.to) break;
      const from = Math.max(visible.from, match.start),
        to = Math.min(visible.to, match.end);
      if (from < to)
        marks.push(
          Decoration.mark({
            class: index === current ? 'preview-code-find-current' : 'preview-code-find-match',
          }).range(from, to),
        );
    }
  }
  return Decoration.set(marks, true);
}
export const codeFindExtensions = [
  findState,
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = visibleMatches(view);
      }
      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.startState.field(findState) !== update.state.field(findState)
        )
          this.decorations = visibleMatches(update.view);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  ),
];
