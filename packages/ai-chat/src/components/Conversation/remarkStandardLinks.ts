interface MarkdownNode {
  type: string;
  url?: string;
  value?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number } };
}

/** Keep CommonMark links and GFM website autolinks in conversation text.
 * Bare emails stay as text; files and inline code are never guessed into links.
 * Reference links are resolved normally by the Markdown parser. */
export function remarkStandardLinks() {
  return (tree: MarkdownNode, file: { value: unknown }) => {
    const source = String(file.value);
    const walk = (node: MarkdownNode) => {
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        if (child.type === 'link') {
          const offset = child.position?.start.offset;
          const marker = offset === undefined ? '' : source[offset];
          // Standard inline links start with [, and URI/email autolinks with <.
          // GFM literal links have neither marker (some also lack a position).
          const website = /^https?:\/\//i.test(child.url ?? '');
          if (marker !== '[' && marker !== '<' && !website) return child.children ?? [];
          if (marker !== '[' && marker !== '<' && website && child.children?.length === 1) {
            const text = child.children[0];
            const suffix = /[。，、；：！？）】》」』]+$/.exec(text?.value ?? '')?.[0];
            if (suffix && child.url?.endsWith(suffix) && text) {
              child.url = child.url.slice(0, -suffix.length);
              text.value = text.value!.slice(0, -suffix.length);
              return [child, { type: 'text', value: suffix }];
            }
          }
        }
        walk(child);
        return [child];
      });
    };
    walk(tree);
  };
}
