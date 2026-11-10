interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
}

const SKIP = new Set(['code', 'inlineCode', 'link', 'linkReference', 'definition', 'html']);
const TAG = '(?:nomi-report|nomi-report)';
const OPEN = new RegExp(`^\\s*\\[${TAG}\\](?=\\s*(?:\\r?\\n|做了什么[:：]|What I did:|$))`, 'i');
const CLOSE = new RegExp(`\\s*\\[/${TAG}\\]\\s*$`);
const LINE = new RegExp(`(^|\\r?\\n)[ \\t]*\\[/?${TAG}\\][ \\t]*(?=\\r?\\n|$)`, 'g');
const MARKERS = ['[nomi-report]', '[/nomi-report]', '[nomi-report]', '[/nomi-report]'];

function walk(node: MarkdownNode): void {
  if (!node.children || SKIP.has(node.type)) return;
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string') {
      child.value = child.value.replace(OPEN, '').replace(CLOSE, '').replace(LINE, '$1');
      const partial = child.value.trim();
      if (
        partial &&
        node.children.length === 1 &&
        MARKERS.some((marker) => marker.startsWith(partial))
      ) {
        child.value = '';
      }
    } else {
      walk(child);
    }
  }
}

export function remarkDelegateReport() {
  return (tree: MarkdownNode) => walk(tree);
}
