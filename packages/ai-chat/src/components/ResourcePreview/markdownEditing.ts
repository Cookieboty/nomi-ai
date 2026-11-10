/** Source-preserving block edits: untouched Markdown (including Mermaid, links and
 * reference definitions) is never regenerated from the rendered DOM. */
export interface MarkdownPatch {
  start: number;
  end: number;
  text: string;
}
interface AstNode {
  type: string;
  value?: string;
  lang?: string;
  children?: AstNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
  data?: { hProperties?: Record<string, unknown> };
}
export function remarkEditableBlocks() {
  return (tree: AstNode, file: { value: unknown }) => {
    const source = String(file.value);
    // A blank source still needs a positioned paragraph for native input/paste/IME.
    // Its zero-width insertion point keeps the original whitespace untouched.
    if (tree.type === 'root' && !source.trim()) {
      const offset = source.length;
      const line = source.split('\n').length;
      const position = { start: { offset }, end: { offset } };
      tree.children = [
        {
          type: 'paragraph',
          position,
          data: {
            hProperties: {
              'data-md-empty-document': true,
              'data-preview-source-start': offset,
              'data-preview-source-end': offset,
              'data-preview-line-start': line,
              'data-preview-line-end': line,
            },
          },
          children: [{ type: 'text', value: '', position }],
        },
      ];
    }
    const visit = (node: AstNode, parent?: AstNode, index = 0) => {
      const children = node.children ?? [];
      if (node.type === 'tableRow') {
        const rowStart = node.position?.start.offset;
        const rowEnd = node.position?.end.offset;
        const tableStart = parent?.position?.start.offset;
        const tableEnd = parent?.position?.end.offset;
        if (rowStart !== undefined && rowEnd !== undefined)
          children.forEach((cell) => {
            cell.data ??= {};
            cell.data.hProperties ??= {};
            Object.assign(cell.data.hProperties, {
              'data-md-row-start': rowStart,
              'data-md-row-end': rowEnd,
              'data-md-row-header': parent?.type === 'table' && index === 0 ? true : undefined,
              'data-md-table-start': tableStart,
              'data-md-table-end': tableEnd,
            });
          });
      }
      let start = children[0]?.position?.start.offset;
      let end = children[children.length - 1]?.position?.end.offset;
      let kind = '';
      if (node.type === 'tableCell' && !children.length) {
        start = node.position?.start.offset;
        if (start !== undefined) {
          if (source[start] === '|') start++;
          if (source[start] === ' ') start++;
        }
        end = start;
      }
      if (['paragraph', 'heading', 'tableCell'].includes(node.type)) kind = node.type;
      if (node.type === 'listItem' && children.length === 1 && children[0]?.type === 'paragraph') {
        const inline = children[0].children ?? [];
        start = inline[0]?.position?.start.offset;
        end = inline[inline.length - 1]?.position?.end.offset;
        kind = 'listItem';
      }
      if (kind && start !== undefined && end !== undefined) {
        node.data ??= {};
        node.data.hProperties ??= {};
        Object.assign(node.data.hProperties, {
          'data-md-start': start,
          'data-md-end': end,
          'data-md-kind': kind,
          'data-md-block-start': node.position?.start.offset,
          'data-md-block-end': node.position?.end.offset,
        });
      }
      if (node.type === 'code' && node.lang !== 'mermaid') {
        const a = node.position?.start.offset,
          b = node.position?.end.offset;
        if (a !== undefined && b !== undefined) {
          const raw = source.slice(a, b);
          const opening = /^[ \t]*(`{3,}|~{3,})[^\r\n]*\r?\n/.exec(raw);
          const closing = /\r?\n[ \t]*(?:`{3,}|~{3,})[ \t]*$/.exec(raw);
          if (opening && closing) {
            node.data ??= {};
            node.data.hProperties ??= {};
            Object.assign(node.data.hProperties, {
              'data-md-start': a + opening[0].length,
              'data-md-end': a + closing.index,
              'data-md-kind': 'code',
              'data-md-outer-start': a,
              'data-md-outer-end': b,
            });
          }
        }
      }
      // Preserve inline spelling and reference links when those DOM subtrees are unchanged.
      if (
        [
          'link',
          'linkReference',
          'strong',
          'emphasis',
          'delete',
          'inlineCode',
          'image',
          'imageReference',
        ].includes(node.type)
      ) {
        const a = node.position?.start.offset;
        const b = node.position?.end.offset;
        if (a !== undefined && b !== undefined) {
          node.data ??= {};
          node.data.hProperties ??= {};
          node.data.hProperties['data-md-original'] = source.slice(a, b);
          if (node.type === 'image') node.data.hProperties.contentEditable = false;
        }
      }
      children.forEach((child, childIndex) => visit(child, node, childIndex));
    };
    visit(tree);
  };
}
function escapeText(text: string, table: boolean): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/([*_`[\]<>])/g, '\\$1')
    .replace(table ? /\|/g : /$^/g, '\\|')
    .replace(table ? /\r\n?|\n/g : /$^/g, '<br>');
}
/** Serialize only safe inline structure. Pasted HTML is never executed or written back. */
export function inlineMarkdown(root: HTMLElement, table = false): string {
  const walk = (node: Node): string => {
    if (node.nodeType === 3) return escapeText(node.textContent ?? '', table);
    if (node.nodeType !== 1) return '';
    const el = node as HTMLElement;
    if (el.matches('script,style,iframe,object,button,input,svg,[data-preview-line-placeholder]'))
      return '';
    const original = el.dataset.mdOriginal;
    const snapshot = el.dataset.mdSnapshot;
    if (original !== undefined && snapshot === el.textContent) return original;
    const inner = Array.from(el.childNodes).map(walk).join('');
    switch (el.tagName) {
      case 'BR':
        return table ? '<br>' : '  \n';
      case 'DIV':
      case 'P':
        return `${node.previousSibling ? (table ? '<br>' : '\n\n') : ''}${inner}`;
      case 'STRONG':
      case 'B':
        return `**${inner}**`;
      case 'EM':
      case 'I':
        return `*${inner}*`;
      case 'DEL':
      case 'S':
      case 'STRIKE':
        return `~~${inner}~~`;
      case 'CODE': {
        const text = el.textContent ?? '';
        const ticks = '`'.repeat(
          Math.max(1, ...(text.match(/`+/g) ?? []).map((v) => v.length + 1)),
        );
        return `${ticks}${text.includes('`') ? ' ' : ''}${text}${text.includes('`') ? ' ' : ''}${ticks}`;
      }
      case 'A': {
        const href = el.getAttribute('data-md-href') ?? el.getAttribute('href') ?? '';
        if (/^(?:javascript|data|vbscript):/i.test(href)) return inner;
        return `[${inner}](${href.replace(/\(/g, '%28').replace(/\)/g, '%29')})`;
      }
      case 'IMG':
        return original ?? '';
      default:
        return inner;
    }
  };
  return Array.from(root.childNodes).map(walk).join('').replace(/\n+$/, '');
}
export function applyMarkdownPatches(source: string, patches: MarkdownPatch[]): string {
  let last = source.length;
  let result = source;
  for (const patch of [...patches].sort((a, b) => b.start - a.start)) {
    if (patch.start < 0 || patch.end < patch.start || patch.end > last)
      throw new Error('overlapping Markdown edits');
    result = result.slice(0, patch.start) + patch.text + result.slice(patch.end);
    last = patch.start;
  }
  return result;
}
/** Expand a structural deletion over its adjacent Markdown line separator. */
export function structuralDeletePatch(
  source: string,
  start: number,
  end: number,
  lineOnly = false,
): MarkdownPatch {
  const after = source.slice(end);
  const before = source.slice(0, start);
  const forward = lineOnly ? /^(?:\r?\n)/ : /^(?:\r?\n){1,2}/;
  const backward = lineOnly ? /(?:\r?\n)$/ : /(?:\r?\n){1,2}$/;
  const next = forward.exec(after)?.[0];
  const previous = backward.exec(before)?.[0];
  if (!lineOnly && next && next === after && previous) {
    start -= previous.length;
    end += next.length;
  } else if (next) end += next.length;
  else if (previous) start -= previous.length;
  return { start, end, text: '' };
}

/** Text model for editable fenced code, including native browser line containers. */
export function markdownCodeText(root: ParentNode): string {
  const plain = (node: Node): string => {
    if (node.nodeType === 3) return node.textContent ?? '';
    if (node.nodeType !== 1) return '';
    const el = node as HTMLElement;
    if (el.hasAttribute('data-preview-line-placeholder')) return '';
    if (el.tagName === 'BR') return '\n';
    const children = Array.from(el.childNodes).map(plain).join('');
    return `${el.tagName === 'DIV' && node.previousSibling ? '\n' : ''}${children}`;
  };
  return Array.from(root.childNodes).map(plain).join('');
}

export function blockMarkdown(root: HTMLElement, source: string): MarkdownPatch {
  const start = Number(root.dataset.mdStart),
    end = Number(root.dataset.mdEnd);
  const old = source.slice(start, end);
  let text = inlineMarkdown(root, root.dataset.mdKind === 'tableCell');
  if (root.dataset.mdKind === 'code') {
    text = markdownCodeText(root);
    if (source.includes('\r\n')) text = text.replace(/\r?\n/g, '\r\n');
    const outerStart = Number(root.dataset.mdOuterStart),
      outerEnd = Number(root.dataset.mdOuterEnd);
    const opening = source.slice(outerStart, start),
      closing = source.slice(end, outerEnd);
    const fence = /(`{3,}|~{3,})/.exec(opening)![1]!;
    const runs = text.split(/\r?\n/).map((line) => /^[ \t]*([`~]{3,})/.exec(line)?.[1] ?? '');
    const size = Math.max(
      fence.length,
      ...runs.filter((run) => run[0] === fence[0]).map((run) => run.length + 1),
    );
    const widened = fence[0]!.repeat(size);
    return {
      start: outerStart,
      end: outerEnd,
      text: opening.replace(fence, widened) + text + closing.replace(/[`~]{3,}/, widened),
    };
  }
  // Keep container prefixes on multiline blockquotes/list items rather than flattening them.
  const prefix = /\n([ \t]*(?:> ?)+[ \t]*)/.exec(old)?.[1];
  if (prefix) text = text.replace(/\n/g, `\n${prefix}`);
  if (source.includes('\r\n')) text = text.replace(/\r?\n/g, '\r\n');
  return { start, end, text };
}
