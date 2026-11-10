import React, { memo, useMemo } from 'react';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

import { resourceTarget } from '../../utils/resourceLinks';

import { ConversationLink } from './ConversationLink';
import { sanitizeHref } from './Markdown.helpers';

interface Node {
  type: string;
  value?: string;
  url?: string;
  identifier?: string;
  children?: Node[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}
const parser = unified().use(remarkParse).use(remarkGfm);
const label = (node: Node): string => node.value ?? node.children?.map(label).join('') ?? '';

/** Parse link syntax without changing the surrounding user text or its stored source. */
export const UserMessageLinks = memo(function UserMessageLinks({ text }: { text: string }) {
  const parts = useMemo(() => {
    const tree = parser.parse(text) as Node;
    const definitions = new Map<string, string>();
    const collect = (node: Node) => {
      if (node.type === 'definition' && node.identifier && node.url)
        definitions.set(node.identifier.toUpperCase(), node.url);
      node.children?.forEach(collect);
    };
    collect(tree);
    const links: Array<{ start: number; end: number; href: string; label: string }> = [];
    const visit = (node: Node) => {
      if (['code', 'inlineCode', 'definition', 'html'].includes(node.type)) return;
      let href =
        node.type === 'link'
          ? node.url
          : node.type === 'linkReference' && node.identifier
            ? definitions.get(node.identifier.toUpperCase())
            : undefined;
      const start = node.position?.start.offset;
      let end = node.position?.end.offset;
      let title = label(node);
      if (
        href &&
        start !== undefined &&
        end !== undefined &&
        !['[', '<'].includes(text[start]!) &&
        /^https?:\/\//i.test(href)
      ) {
        const suffix = /[。，、；：！？）】》」』]+$/.exec(title)?.[0];
        if (suffix && href.endsWith(suffix)) {
          href = href.slice(0, -suffix.length);
          end -= suffix.length;
          title = title.slice(0, -suffix.length);
        }
      }
      if (
        href &&
        start !== undefined &&
        end !== undefined &&
        (resourceTarget(href) || sanitizeHref(href))
      ) {
        links.push({ start, end, href, label: title });
        return;
      }
      node.children?.forEach(visit);
    };
    visit(tree);
    const output: React.ReactNode[] = [];
    let offset = 0;
    for (const link of links) {
      output.push(text.slice(offset, link.start));
      output.push(
        <ConversationLink key={link.start} href={link.href} imageOrigin="user">
          {link.label}
        </ConversationLink>,
      );
      offset = link.end;
    }
    output.push(text.slice(offset));
    return output;
  }, [text]);
  return <>{parts}</>;
});
