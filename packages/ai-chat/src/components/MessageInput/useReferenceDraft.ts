import { useMemo, type Dispatch, type SetStateAction } from 'react';

import { basename, resourceTarget, workspaceFileHref } from '../../utils/resourceLinks';

export interface ComposerReference {
  href: string;
  label: string;
  markdown: string;
}

/** Only absolute file references with source lines become links in the composer. */
export function splitReferenceDraft(value: string): {
  text: string;
  references: ComposerReference[];
} {
  const references: ComposerReference[] = [];
  const lines = value.split('\n'),
    prose: string[] = [];
  let fence: { char: string; length: number } | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = { char: marker[1]![0]!, length: marker[1]!.length };
      else if (
        marker[1]![0] === fence.char &&
        marker[1]!.length >= fence.length &&
        !marker[2]!.trim()
      )
        fence = null;
      prose.push(line);
      continue;
    }
    const match = !fence && /^[ \t]*\[((?:\\.|[^\]\\])*)\]\(([^\n)]+)\)[ \t]*\r?$/.exec(line);
    const target = match ? resourceTarget(match[2]!) : null;
    if (!target?.path || !target.line || !/^(?:\/|[A-Za-z]:[\\/])/.test(target.path)) {
      prose.push(line);
      continue;
    }
    const label = `${basename(target.path)}:${target.line}-${target.lineEnd ?? target.line}`;
    const safeLabel = label.replace(/[\\[\]]/g, '\\$&');
    const absolute = `${workspaceFileHref('', target.path).replace(/\(/g, '%28').replace(/\)/g, '%29')}:${target.line}-${target.lineEnd ?? target.line}`;
    references.push({ href: absolute, label, markdown: `[${safeLabel}](${absolute})` });
    if (lines.slice(index + 1).every((next) => !next.trim())) {
      while (prose.length && prose[prose.length - 1] === '') prose.pop();
      break;
    }
    if (lines[index + 1] === '') index++;
  }
  return {
    text: prose.join('\n'),
    references: [...new Map(references.map((reference) => [reference.href, reference])).values()],
  };
}

export function joinReferenceDraft(references: ComposerReference[], text: string): string {
  const unique = [...new Map(references.map((item) => [item.href, item])).values()];
  return unique.length ? `${unique.map((item) => item.markdown).join('\n')}\n\n${text}` : text;
}

/** Draft storage and sends retain Markdown; editing and caret operations see only prose. */
export function useReferenceDraft(raw: string, setRaw: Dispatch<SetStateAction<string>>) {
  const draft = useMemo(() => splitReferenceDraft(raw), [raw]);
  return {
    ...draft,
    serialized: joinReferenceDraft(draft.references, draft.text),
    setText: (next: SetStateAction<string>) =>
      setRaw((previous) => {
        const current = splitReferenceDraft(previous);
        const changed = splitReferenceDraft(typeof next === 'function' ? next(current.text) : next);
        return joinReferenceDraft([...current.references, ...changed.references], changed.text);
      }),
    append: (fill: string) =>
      setRaw((previous) => {
        const current = splitReferenceDraft(previous),
          extra = splitReferenceDraft(fill);
        const text = extra.text.trim()
          ? current.text.trim()
            ? `${current.text.replace(/\s+$/, '')}\n\n${extra.text}`
            : extra.text
          : current.text;
        return joinReferenceDraft([...current.references, ...extra.references], text);
      }),
    remove: (href: string) =>
      setRaw((previous) => {
        const current = splitReferenceDraft(previous);
        return joinReferenceDraft(
          current.references.filter((item) => item.href !== href),
          current.text,
        );
      }),
  };
}
