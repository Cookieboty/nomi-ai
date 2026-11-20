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

  it('posts targeted openId when clicking a notice row or island pill while keeping pending items interactive', async () => {
    const win = new Window({ settings: { enableJavaScriptEvaluation: true } });
    try {
      const posts: string[] = [];
      Object.assign(win, { chrome: { webview: { postMessage: (m: string) => posts.push(m) } } });
      win.document.write(html);

      // 1. 单条通知带 openId：点标题行或点胶囊都发送带 openId 的消息并收起通知
      win.eval(
        `window.__island.show({title:'Codex',body:'Done',openId:'tab\\x1ftab_3',durationMs:60000})`,
      );
      win.document.querySelector<HTMLElement>('.title')!.click();
      expect(posts).toContain('nomi:island:open:"tab\\u001ftab_3"');

      // 点空白胶囊区域同样发带 openId 的 open
      posts.length = 0;
      win.eval(`window.__island.show({title:'Nomi',body:'Hello',openId:'nomi',durationMs:60000})`);
      win.document.querySelector<HTMLElement>('#island')!.click();
      expect(posts).toContain('nomi:island:open:"nomi"');

      // 2. 与 pending 共存的 list 模式：点通知行发通知的 openId，点待处理行仍发 pending 的 id
      posts.length = 0;
      win.eval(
        `window.__island.setPending([{id:'perm\\x1ftab_9\\x1freq_1',title:'Approval',body:'Details',actions:[{id:'allow',label:'Allow'}]}])`,
      );
      win.eval(
        `window.__island.show({title:'Task',body:'Done',openId:'task\\x1ftk_7',durationMs:60000})`,
      );
      const rows = win.document.querySelectorAll<HTMLElement>('#rows .row');
      expect(rows.length).toBe(2);
      rows[1]!.querySelector<HTMLElement>('.title')!.click();
      expect(posts).toContain('nomi:island:open:"perm\\u001ftab_9\\u001freq_1"');

      posts.length = 0;
      rows[0]!.querySelector<HTMLElement>('.title')!.click();
      expect(posts).toContain('nomi:island:open:"task\\u001ftk_7"');
      // 通知行被点击收起后，仅剩 pending 一项
      expect(win.document.querySelectorAll('#rows .row').length).toBe(1);
    } finally {
      await win.happyDOM.close();
    }
  });
});
