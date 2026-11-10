import type { MarkdownParseResponse, PreviewMarkdownTree } from './markdownParse';

export const LARGE_MARKDOWN_SIZE = 100_000;
interface Snapshot {
  text: string;
  editable: boolean;
  tree: PreviewMarkdownTree;
}
interface Pending {
  text: string;
  editable: boolean;
  resolve: (tree: PreviewMarkdownTree) => void;
  reject: (error: Error) => void;
  promise: Promise<PreviewMarkdownTree>;
}
let worker: Worker | undefined;
let sequence = 0;
let consumers = 0;
let idle: ReturnType<typeof setTimeout> | undefined;
let cached: Snapshot | undefined;
const pending = new Map<number, Pending>();

function dispose() {
  worker?.terminate();
  worker = undefined;
  cached = undefined;
  pending.forEach((request) => request.reject(new Error('Markdown parser closed')));
  pending.clear();
}

/** Keep one recent AST across source/preview switches, then release private document
 * data and the worker after the last Markdown view has been absent for ten seconds. */
export function retainMarkdownParser() {
  consumers++;
  clearTimeout(idle);
  return () => {
    consumers--;
    if (!consumers) idle = setTimeout(dispose, 10_000);
  };
}
export function cachedMarkdown(text: string, editable: boolean) {
  return cached?.text === text && cached.editable === editable ? cached.tree : undefined;
}
export function prepareMarkdown(text: string, editable: boolean): Promise<PreviewMarkdownTree> {
  const tree = cachedMarkdown(text, editable);
  if (tree) return Promise.resolve(tree);
  for (const request of pending.values())
    if (request.text === text && request.editable === editable) return request.promise;
  if (!worker) {
    worker = new Worker(new URL('./markdownParse.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }: MessageEvent<MarkdownParseResponse>) => {
      const request = pending.get(data.id);
      if (!request) return;
      pending.delete(data.id);
      if ('error' in data) request.reject(new Error(data.error));
      else {
        cached = { text: request.text, editable: request.editable, tree: data.tree };
        request.resolve(data.tree);
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      dispose();
    };
    worker.onmessageerror = () => dispose();
  }
  const id = ++sequence;
  let resolve!: Pending['resolve'];
  let reject!: Pending['reject'];
  const promise = new Promise<PreviewMarkdownTree>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  pending.set(id, { text, editable, resolve, reject, promise });
  try {
    worker.postMessage({ id, text, editable });
  } catch {
    dispose();
  }
  return promise;
}
if (import.meta.hot) import.meta.hot.dispose(dispose);
