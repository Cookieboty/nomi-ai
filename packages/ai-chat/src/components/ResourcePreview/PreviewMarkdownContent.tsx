import { createLogger, t, useLocale } from '@nomi-ai/ui';
import React, { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';

import {
  editableRemarkPlugins,
  previewRemarkPlugins,
  type PreviewMarkdownTree,
} from './markdownParse';
import {
  cachedMarkdown,
  LARGE_MARKDOWN_SIZE,
  prepareMarkdown,
  retainMarkdownParser,
} from './markdownParseClient';
import { resourceUrlTransform } from './PreviewMarkdown.helpers';

const log = createLogger('preview-markdown');
type RehypePlugins = React.ComponentProps<typeof ReactMarkdown>['rehypePlugins'];
interface Props {
  text: string;
  editable?: boolean;
  synchronous?: boolean;
  components: Components;
  rehypePlugins?: RehypePlugins;
  onRendered?: () => void;
}
interface Prepared {
  text: string;
  editable: boolean;
  tree?: PreviewMarkdownTree;
  fallback?: boolean;
}

/** Large documents parse away from the UI thread. Both paths render with the
 * existing ReactMarkdown component, including its URL transform and HTML policy. */
export const PreviewMarkdownContent = React.memo(function PreviewMarkdownContent({
  text,
  editable = false,
  synchronous = false,
  components,
  rehypePlugins,
  onRendered,
}: Props) {
  useLocale();
  // A live editing transaction must finish before the next browser input event.
  // Only initial loading/read-only refreshes may replace the document with a placeholder.
  const large = text.length >= LARGE_MARKDOWN_SIZE && typeof Worker !== 'undefined';
  const background = !synchronous && large;
  const [prepared, setPrepared] = useState<Prepared | undefined>(() => {
    const tree = background ? cachedMarkdown(text, editable) : undefined;
    return tree ? { text, editable, tree } : undefined;
  });
  const current = prepared?.text === text && prepared.editable === editable ? prepared : undefined;
  const tree = current?.tree ?? cachedMarkdown(text, editable);
  const ready = !background || !!tree || !!current?.fallback;
  useEffect(() => (large ? retainMarkdownParser() : undefined), [large]);
  useEffect(() => {
    if (!background) return;
    let stale = false;
    try {
      void prepareMarkdown(text, editable).then(
        (tree) => {
          if (!stale)
            setPrepared((previous) =>
              previous?.text === text && previous.editable === editable && previous.tree === tree
                ? previous
                : { text, editable, tree },
            );
        },
        (error: unknown) => {
          if (stale) return;
          log.warn('Background parsing unavailable; using the Markdown renderer', error);
          setPrepared({ text, editable, fallback: true });
        },
      );
    } catch (error) {
      log.warn('Background parsing unavailable; using the Markdown renderer', error);
      setPrepared({ text, editable, fallback: true });
    }
    return () => {
      stale = true;
    };
  }, [text, editable, background]);
  const plugins = useMemo(
    () => (tree ? [() => () => tree] : editable ? editableRemarkPlugins : previewRemarkPlugins),
    [tree, editable],
  );
  useLayoutEffect(() => {
    if (ready) onRendered?.();
  }, [ready, text, onRendered]);
  if (!ready)
    return (
      <p data-preview-markdown-pending contentEditable={false} role="status">
        {t('ui.session-workspace.preview-loading')}
      </p>
    );
  return (
    <ReactMarkdown
      remarkPlugins={plugins}
      rehypePlugins={rehypePlugins}
      components={components}
      urlTransform={resourceUrlTransform}
      skipHtml
    >
      {tree ? '' : text}
    </ReactMarkdown>
  );
});
