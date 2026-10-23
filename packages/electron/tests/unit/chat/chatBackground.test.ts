jest.unmock('fs');
jest.mock('../../../src/i18n', () => ({ t: (s: string) => s }));

jest.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [],
    fromWebContents: () => null,
  },
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn() },
  dialog: {
    showOpenDialog: jest.fn(async () => ({ canceled: true, filePaths: [] })),
  },
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ChatBackgroundService,
  DEFAULT_CHAT_BG,
  sanitizeChatBg,
} from '../../../src/chat/ChatBackgroundService';

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'chat-bg-'));

describe('ChatBackgroundService', () => {
  it('sanitizes and defaults', () => {
    expect(sanitizeChatBg(null)).toEqual(DEFAULT_CHAT_BG);
    expect(
      sanitizeChatBg({
        mode: 'solid',
        solidColor: '#ff0000',
        blurLeft: 99,
        blurCenter: -3,
        blurRight: 12,
        opacity: 2,
      }),
    ).toEqual({
      mode: 'solid',
      solidColor: '#ff0000',
      imageUrl: null,
      blurLeft: 40,
      blurCenter: 0,
      blurRight: 12,
      opacity: 1,
    });
    expect(sanitizeChatBg({ mode: 'image', imageUrl: 'http://evil' }).imageUrl).toBeNull();
  });

  it('migrates the legacy single blur to all three panels', () => {
    expect(sanitizeChatBg({ mode: 'image', blur: 8 })).toMatchObject({
      blurLeft: 8,
      blurCenter: 8,
      blurRight: 8,
    });
    expect(sanitizeChatBg({ mode: 'image', blur: 8, blurRight: 2 })).toMatchObject({
      blurLeft: 8,
      blurCenter: 8,
      blurRight: 2,
    });
  });

  it('persists set/reset to disk', () => {
    const root = tmpRoot();
    const file = path.join(root, 'chat-background.json');
    const images = path.join(root, 'images');
    const s = new ChatBackgroundService(file, images);
    expect(s.get().mode).toBe('default');
    expect(
      s.set({ mode: 'solid', solidColor: '#abcdef', blurLeft: 8, opacity: 0.5 }),
    ).toMatchObject({
      mode: 'solid',
      solidColor: '#abcdef',
      blurLeft: 8,
      blurCenter: 0,
      opacity: 0.5,
    });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).mode).toBe('solid');
    expect(s.reset()).toEqual(DEFAULT_CHAT_BG);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).mode).toBe('default');
  });

  it('copies picked image into chat-asset images dir', async () => {
    const { dialog } = jest.requireMock('electron') as {
      dialog: { showOpenDialog: jest.Mock };
    };
    const root = tmpRoot();
    const file = path.join(root, 'chat-background.json');
    const images = path.join(root, 'images');
    const src = path.join(root, 'src.png');
    fs.writeFileSync(src, 'fake-png');
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [src] });
    const s = new ChatBackgroundService(file, images);
    const st = await s.pickImage();
    expect(st.mode).toBe('image');
    expect(st.imageUrl).toBe('chat-asset://images/panel-bg.png');
    expect(fs.existsSync(path.join(images, 'panel-bg.png'))).toBe(true);
    s.reset();
    expect(fs.existsSync(path.join(images, 'panel-bg.png'))).toBe(false);
  });
});
