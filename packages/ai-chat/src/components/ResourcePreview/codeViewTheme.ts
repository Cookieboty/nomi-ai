import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';

export const codeViewHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [tags.comment, tags.meta], class: 'token comment' },
    { tag: [tags.keyword, tags.bool, tags.null, tags.modifier], class: 'token keyword' },
    { tag: [tags.string, tags.character, tags.regexp], class: 'token string' },
    { tag: [tags.number, tags.integer, tags.float], class: 'token number' },
    {
      tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
      class: 'token function',
    },
    // 键名（YAML 键、JSON 键、CSS 属性名）；function(propertyName) 更具体，仍走 token function。
    { tag: tags.propertyName, class: 'token property' },
    { tag: [tags.typeName, tags.className, tags.namespace], class: 'token class-name' },
    { tag: [tags.tagName, tags.attributeName], class: 'token tag' },
    { tag: tags.operator, class: 'token operator' },
  ]),
);
export const codeViewTheme = EditorView.theme({
  '&': {
    height: '100%',
    minHeight: '0',
    backgroundColor: 'transparent',
    color: 'var(--cd-color-text)',
    fontFamily: 'var(--cd-font-mono)',
    fontSize: 'var(--cd-font-size-sm)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: 'inherit',
    lineHeight: 'var(--cd-line-height-lg)',
    scrollPaddingTop: 'calc(var(--preview-controls-space, 0px) + var(--cd-space-4))',
  },
  '.cm-content': {
    padding: 'calc(var(--preview-controls-space, 0px) + var(--cd-space-4)) 0 var(--cd-space-4)',
    caretColor: 'var(--cd-color-text)',
    tabSize: '2',
  },
  '.cm-line': { padding: '0 var(--cd-space-4)' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--cd-color-text-subtle)',
    border: 'none',
    userSelect: 'none',
    WebkitUserSelect: 'none',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    minWidth: '4ch',
    padding: '0 var(--cd-space-2) 0 var(--cd-space-4)',
  },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--cd-color-text)' },
  '.cm-specialChar': { color: 'var(--cd-color-danger)' },
  // 匹配 CodeMirror baseTheme 的 5 级选择器特异性，避免聚焦选区回退为默认浅色 #d7d4f0
  '& > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
    background: 'var(--cd-color-accent-soft)',
  },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection':
    {
      background: 'rgba(var(--cd-accent-rgb), 0.26)',
    },
  '.preview-code-location': { backgroundColor: 'var(--cd-color-hover)' },
  '.preview-code-find-match': { backgroundColor: 'var(--cd-color-accent-soft)' },
  '.preview-code-find-current': {
    backgroundColor: 'var(--cd-color-accent-strong)',
    color: 'var(--cd-color-text-on-accent)',
  },
  '.token.comment': { color: 'var(--cd-color-text-muted)', fontStyle: 'italic' },
  '.token.keyword, .token.tag, .token.property': { color: 'var(--cd-color-accent-strong)' },
  '.token.string': { color: 'var(--cd-color-success)' },
  '.token.number, .token.function, .token.class-name': { color: 'var(--cd-color-warning)' },
});
