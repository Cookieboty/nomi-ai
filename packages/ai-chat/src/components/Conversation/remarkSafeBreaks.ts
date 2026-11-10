interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

/** Support the one inline HTML construct used by GFM tables without an HTML parser.
 * Attributes, escaped text, inline code and fenced examples are never interpreted. */
export function remarkSafeBreaks() {
  return (tree: MarkdownNode) => {
    const walk = (node: MarkdownNode) => {
      if (node.type === 'html' && /^<br\s*\/?>$/i.test(node.value ?? '')) {
        const original = node.value;
        // A normal mdast break adds a synthetic newline after <br>, which would
        // corrupt a table row when serializing an adjacent edit.
        node.type = 'safeBreak';
        delete node.value;
        node.data = {
          ...node.data,
          hName: 'br',
          hProperties: { ...node.data?.hProperties, 'data-md-original': original },
        };
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}
