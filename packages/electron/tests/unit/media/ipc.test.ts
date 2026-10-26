// IPC 层：渲染进程经 ai:media:* 拿到的任何返回里都不能出现 Key 明文
jest.unmock('fs');
jest.unmock('path');

const handlers = new Map<string, (...a: unknown[]) => unknown>();
jest.mock('../../../src/security/guardedIpc', () => ({
  guardedHandle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
}));
jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ClipboardItem: class {},
  clipboard: { write: jest.fn() },
  dialog: { showOpenDialog: jest.fn(), showSaveDialog: jest.fn() },
  nativeImage: { createFromBuffer: jest.fn() },
}));

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { registerMediaIpc } from '../../../src/media/ipc';
import { MediaService } from '../../../src/media/MediaService';

const SECRET = 'sk-ipc-secret-9876';

describe('ai:media IPC', () => {
  const svc = new MediaService({
    root: mkdtempSync(path.join(os.tmpdir(), 'media-ipc-')),
    logger: { info: jest.fn(), warn: jest.fn() },
    codec: {
      encrypt: (v) => `enc:${Buffer.from(v).toString('base64')}`,
      decrypt: (v) => (v ? Buffer.from(v.slice(4), 'base64').toString() : ''),
    },
  });
  registerMediaIpc(svc);
  const call = (ch: string, ...a: unknown[]) => handlers.get(ch)!(...a);

  it('写入 Key 后，state / upsert 返回 / 会话模型查询都不含明文或密文', async () => {
    const enc = `enc:${Buffer.from(SECRET).toString('base64')}`;
    const outs = [
      await call('ai:media:upsert-provider', { id: 'openai', apiKey: SECRET }),
      await call('ai:media:set-chat-default', { modelId: 'gpt-image-1', providerRef: 'openai' }),
      await call('ai:media:state'),
      await call('ai:media:session-choice', 'c1'),
      await call('ai:media:set-session-choice', 'c1', {
        modelId: 'gpt-image-1',
        providerRef: 'openai',
      }),
    ];
    for (const o of outs) {
      const s = JSON.stringify(o);
      expect(s).not.toContain(SECRET);
      expect(s).not.toContain(enc);
    }
    const st = (await call('ai:media:state')) as {
      providers: Array<{ id: string; hasKey: boolean }>;
    };
    expect(st.providers.find((p) => p.id === 'openai')?.hasKey).toBe(true);
  });

  it('批量删除 / 导出入参校验：非字符串 id 被丢弃，空列表不弹目录选择', async () => {
    const { dialog } = jest.requireMock('electron') as { dialog: { showOpenDialog: jest.Mock } };
    expect(await call('ai:media:delete-assets', [1, null, 'nope'])).toBe(0);
    expect(await call('ai:media:export-assets', [])).toBe(0);
    expect(dialog.showOpenDialog).not.toHaveBeenCalled();
  });
});
