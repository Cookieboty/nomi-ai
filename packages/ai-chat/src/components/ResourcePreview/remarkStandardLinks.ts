interface MarkdownNode {
  type: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number } };
}

/** Keep CommonMark link syntax; undo only GFM's bare URL/email link extension.
 * Files and inline code are never guessed into links. Reference links remain
 * linkReference nodes and are resolved normally by the Markdown parser. */
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
          if (marker !== '[' && marker !== '<') return child.children ?? [];
        }
        walk(child);
        return [child];
      });
    };
    walk(tree);
  };
}
