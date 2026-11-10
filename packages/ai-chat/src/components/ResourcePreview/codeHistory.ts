import { Annotation, Transaction } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';

import type { MarkdownEditHistory, MarkdownSnapshot } from './markdownEditHistory';

export const externalCodeChange = Annotation.define<boolean>();

/** Apply a source snapshot without recording another edit or replacing the whole model. */
export function syncCodeText(
  editor: EditorView,
  text: string,
  selection?: MarkdownSnapshot['sourceSelection'],
) {
  const current = editor.state.doc.toString();
  const desired = editor.state.toText(text).toString();
  if (desired === current && !selection) return;
  let from = 0,
    oldTo = current.length,
    newTo = desired.length;
  while (from < oldTo && from < newTo && current[from] === desired[from]) from++;
  while (oldTo > from && newTo > from && current[oldTo - 1] === desired[newTo - 1]) {
    oldTo--;
    newTo--;
  }
  editor.dispatch({
    changes:
      desired !== current ? { from, to: oldTo, insert: desired.slice(from, newTo) } : undefined,
    selection: selection && {
      anchor: Math.min(selection.anchor, desired.length),
      head: Math.min(selection.head, desired.length),
    },
    annotations: [externalCodeChange.of(true), Transaction.addToHistory.of(false)],
  });
}

/** Markdown's two editors share source transactions; plain code keeps CodeMirror history. */
export function markdownCodeHistory(
  getHistory: () => MarkdownEditHistory | undefined,
  onChange: (text: string) => void,
) {
  const restore = (editor: EditorView, redo = false) => {
    const history = getHistory();
    if (!history) return false;
    if (editor.state.readOnly) return true;
    const { anchor, head } = editor.state.selection.main;
    history.present.sourceSelection = { anchor, head };
    const snapshot = redo ? history.redo() : history.undo();
    if (snapshot) {
      syncCodeText(editor, snapshot.text, snapshot.sourceSelection ?? { anchor, head });
      onChange(snapshot.text);
    }
    return true;
  };
  return [
    keymap.of([
      { key: 'Mod-z', run: (editor) => restore(editor), preventDefault: true },
      { key: 'Mod-Shift-z', run: (editor) => restore(editor, true), preventDefault: true },
      { key: 'Mod-y', run: (editor) => restore(editor, true), preventDefault: true },
    ]),
    EditorView.domEventHandlers({
      beforeinput: (event, editor) => {
        if (!getHistory() || !['historyUndo', 'historyRedo'].includes(event.inputType))
          return false;
        event.preventDefault();
        return restore(editor, event.inputType === 'historyRedo');
      },
    }),
    EditorView.updateListener.of((update) => {
      const history = getHistory();
      if (!history) return;
      const { anchor, head } = update.state.selection.main;
      if (!update.docChanged) {
        if (update.selectionSet) history.present.sourceSelection = { anchor, head };
        return;
      }
      if (update.transactions.every((tr) => tr.annotation(externalCodeChange))) return;
      const previous = update.startState.selection.main;
      history.present.sourceSelection = { anchor: previous.anchor, head: previous.head };
      const event = update.transactions
        .find((tr) => tr.annotation(Transaction.userEvent))
        ?.annotation(Transaction.userEvent);
      const group =
        event?.startsWith('input.type') || event?.startsWith('delete') ? `source:${event}` : '';
      const text = update.state.sliceDoc();
      history.record(text, undefined, group, { anchor, head });
      onChange(text);
    }),
  ];
}
