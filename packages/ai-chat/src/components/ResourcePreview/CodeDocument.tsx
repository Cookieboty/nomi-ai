import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { Compartment, EditorState } from '@codemirror/state';
import {
  Decoration,
  drawSelection,
  EditorView,
  keymap,
  lineNumbers,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { t } from '@nomi-ai/ui';
import React, { useLayoutEffect, useRef } from 'react';

import styles from './CodeDocument.module.css';
import { externalCodeChange, markdownCodeHistory, syncCodeText } from './codeHistory';
import { codeLanguageSupport } from './codeLanguages';
import { codeFindExtensions } from './codeViewModel';
import { codeViewHighlight, codeViewTheme } from './codeViewTheme';
import type { MarkdownEditHistory } from './markdownEditHistory';

interface Props {
  text: string;
  language: string;
  editable?: boolean;
  line?: number;
  lineEnd?: number;
  viewportRef: (element: HTMLElement | null) => void;
  onRendered: () => void;
  onScroll: (top: number) => void;
  onChange?: (text: string) => void;
  editHistory?: MarkdownEditHistory;
}
/** One document model for reading and editing. CodeMirror owns viewport drawing,
 * syntax parsing, selection and copy. Markdown history is shared with its rendered
 * editor; plain code uses CodeMirror history. Saving stays in previewEdits. */
export function CodeDocument(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef(props);
  const compartments = useRef({
    language: new Compartment(),
    editable: new Compartment(),
    location: new Compartment(),
  });
  useLayoutEffect(() => {
    latest.current = props;
  });
  useLayoutEffect(() => {
    const mounted = host.current!;
    const parts = compartments.current;
    const editor = new EditorView({
      parent: mounted,
      state: EditorState.create({
        doc: props.text,
        selection: props.editHistory?.present.sourceSelection,
        extensions: [
          EditorState.lineSeparator.of(props.text.includes('\r\n') ? '\r\n' : '\n'),
          EditorState.tabSize.of(2),
          codeViewTheme,
          codeViewHighlight,
          codeFindExtensions,
          lineNumbers(),
          drawSelection(),
          ...(props.editHistory ? [] : [history()]),
          markdownCodeHistory(
            () => latest.current.editHistory,
            (text) => latest.current.onChange?.(text),
          ),
          bracketMatching(),
          indentOnInput(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          parts.language.of(codeLanguageSupport(props.language)),
          parts.editable.of(editableConfig(!!props.editable)),
          parts.location.of(locationLines(props.line, props.lineEnd)),
          EditorView.updateListener.of((update) => {
            if (
              !latest.current.editHistory &&
              update.docChanged &&
              update.transactions.some((transaction) => !transaction.annotation(externalCodeChange))
            ) {
              latest.current.onChange?.(update.state.sliceDoc());
            }
          }),
          EditorView.domEventHandlers({
            scroll: (_event, current) => latest.current.onScroll(current.scrollDOM.scrollTop),
          }),
        ],
      }),
    });
    view.current = editor;
    editor.scrollDOM.dataset.testid = 'resource-preview-source';
    editor.scrollDOM.dataset.previewFindContent = '';
    editor.scrollDOM.dataset.previewCodeScroll = '';
    editor.scrollDOM.dataset.codeLanguage = props.language;
    editor.dom.dataset.previewCodeEditor = '';
    props.viewportRef(editor.scrollDOM);
    props.onRendered();
    return () => {
      latest.current.viewportRef(null);
      view.current = null;
      latest.current.editHistory?.closeGroup();
      editor.destroy();
    };
    // Mount once per file. Compartments keep history and selection across mode/language changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useLayoutEffect(() => {
    const editor = view.current;
    if (!editor) return;
    syncCodeText(editor, props.text);
  }, [props.text]);
  useLayoutEffect(() => {
    const editor = view.current;
    if (!editor) return;
    editor.dispatch({
      effects: compartments.current.language.reconfigure(codeLanguageSupport(props.language)),
    });
    editor.scrollDOM.dataset.codeLanguage = props.language;
  }, [props.language]);
  useLayoutEffect(() => {
    const editor = view.current;
    if (!editor) return;
    editor.dispatch({
      effects: compartments.current.editable.reconfigure(editableConfig(!!props.editable)),
    });
    editor.dom.dataset.editable = String(!!props.editable);
  }, [props.editable]);
  useLayoutEffect(() => {
    view.current?.dispatch({
      effects: compartments.current.location.reconfigure(locationLines(props.line, props.lineEnd)),
    });
  }, [props.line, props.lineEnd]);
  return <div ref={host} className={styles.host} />;
}
function editableConfig(editable: boolean) {
  return [
    EditorState.readOnly.of(!editable),
    EditorView.editable.of(editable),
    EditorView.contentAttributes.of({
      'aria-label': t('ui.session-workspace.preview-edit-document'),
      tabindex: '0',
      spellcheck: 'false',
    }),
  ];
}
function locationLines(start?: number, end = start) {
  const draw = (editor: EditorView) => {
    const marks = [];
    const drawn = new Set<number>();
    for (const visible of editor.visibleRanges) {
      for (let pos = visible.from; pos <= visible.to;) {
        const line = editor.state.doc.lineAt(pos);
        if (drawn.has(line.from)) break;
        drawn.add(line.from);
        const active = !!start && line.number >= start && line.number <= (end ?? start);
        marks.push(
          Decoration.line({
            attributes: {
              id: `preview-line-${line.number}`,
              'data-preview-find-line': 'true',
              'data-preview-line-start': String(line.number),
              'data-preview-line-end': String(line.number),
              ...(active ? { class: 'preview-code-location', 'data-active': 'true' } : {}),
            },
          }).range(line.from),
        );
        if (line.to >= visible.to) break;
        pos = line.to + 1;
      }
    }
    return Decoration.set(marks, true);
  };
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(editor: EditorView) {
        this.decorations = draw(editor);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) this.decorations = draw(update.view);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}
