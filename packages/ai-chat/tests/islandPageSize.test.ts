import { readFileSync } from 'node:fs';

import { repoPath } from '@nomi-ai/repo-paths';
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';

const source = readFileSync(repoPath('apps/desktop-go/internal/core/island/island.html'), 'utf8');
const values: Record<string, string | number> = {
  mode: 'pill',
  preset: 'large',
  width: 440,
  cw: 160,
  ch: 36,
  inset: 0,
  padT: 5,
  padB: 5,
  mx: 14,
  listMax: 226,
  listRows: 4,
};
const html = source.replace(/⟦(\w+)⟧/g, (token, key: string) => String(values[key] ?? token));
const layout = (preset: string) => ({
  preset,
  mode: 'pill',
  width: preset === 'small' ? 300 : preset === 'medium' ? 360 : 440,
  collapsed: { width: 160, height: 36 },
  inset: 0,
  pad: { top: 5, bottom: 5 },
  margin: { x: 14, bottom: 18 },
});

describe('island size changes preserve page state', () => {
  it.each(['large', 'medium', 'small'])(
    'keeps existing click actions and busy state when resizing to %s',
    async (preset) => {
      const win = new Window({ settings: { enableJavaScriptEvaluation: true } });
      try {
        const posts: string[] = [];
        Object.assign(win, { chrome: { webview: { postMessage: (m: string) => posts.push(m) } } });
        win.document.write(html);
        win.eval(
          `window.__island.setPending([{id:'a',title:'Approval',body:'Details',actions:[{id:'allow',label:'Allow'}]}])`,
        );
        win.document.querySelector<HTMLButtonElement>('.btn')!.click();
        win.eval(`window.__island.setLayout(${JSON.stringify(layout(preset))})`);
        expect(win.document.querySelector<HTMLButtonElement>('.btn')!.disabled).toBe(true);
        expect(posts).toContain('nomi:island:act:{"id":"a","action":"allow"}');
        win.document.querySelector<HTMLElement>('.title')!.click();
        expect(posts).toContain('nomi:island:open:"a"');
        win.eval(`window.__island.actFailed('a')`);
        expect(win.document.querySelector<HTMLButtonElement>('.btn')!.disabled).toBe(false);
      } finally {
        await win.happyDOM.close();
      }
    },
  );

  it('sends bounds again after hidden resize even if the next content has the same height', async () => {
    const win = new Window({ settings: { enableJavaScriptEvaluation: true } });
    try {
      const posts: string[] = [];
      Object.assign(win, { chrome: { webview: { postMessage: (m: string) => posts.push(m) } } });
      win.document.write(html);
      win.eval(`window.__island.show({title:'Notice',body:'Details',durationMs:60000})`);
      win.eval('window.__island.hide()');
      posts.length = 0;
      win.eval(`window.__island.setLayout(${JSON.stringify(layout('small'))})`);
      win.eval(`window.__island.show({title:'Notice',body:'Details',durationMs:60000})`);
      expect(posts.some((m) => m.startsWith('nomi:island:size:'))).toBe(true);
      win.document.querySelector<HTMLElement>('.title')!.click();
      expect(posts).toContain('nomi:island:open');
      expect(win.document.querySelector('#island')!.getAttribute('data-size')).toBe('small');
    } finally {
      await win.happyDOM.close();
    }
  });
});
