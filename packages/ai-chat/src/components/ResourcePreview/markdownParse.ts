import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

import { remarkEditableBlocks } from './markdownEditing';
import { remarkPreviewSourceRanges } from './previewSourceRanges';
import { remarkSafeBreaks } from './remarkSafeBreaks';
import { remarkStandardLinks } from './remarkStandardLinks';

export const previewRemarkPlugins = [
  remarkGfm,
  remarkSafeBreaks,
  remarkStandardLinks,
  remarkPreviewSourceRanges,
];
export const editableRemarkPlugins = [...previewRemarkPlugins, remarkEditableBlocks];

/** The same remark pipeline runs in the worker and the synchronous fallback.
 * ReactMarkdown still owns HAST conversion, URL safety and component rendering. */
export function parsePreviewMarkdown(text: string, editable: boolean) {
  const processor = unified()
    .use(remarkParse)
    .use(editable ? editableRemarkPlugins : previewRemarkPlugins);
  return processor.runSync(processor.parse(text), { value: text });
}
export type PreviewMarkdownTree = ReturnType<typeof parsePreviewMarkdown>;
export interface MarkdownParseRequest {
  id: number;
  text: string;
  editable: boolean;
}
export type MarkdownParseResponse =
  { id: number; tree: PreviewMarkdownTree } | { id: number; error: string };
