jest.unmock('fs');
jest.unmock('path');
jest.mock('../../../src/i18n', () => ({ t: (s: string) => s }));

jest.mock('electron', () => ({
  app: { isPackaged: false },
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
  CHAT_BG_PRESET_URL,
  DEFAULT_CHAT_BG,
  sanitizeChatBg,
} from '../../../src/chat/ChatBackgroundService';

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'chat-bg-'));
const PRESET_DEFAULTS = { ...DEFAULT_CHAT_BG, mode: 'image', imageUrl: CHAT_BG_PRESET_URL };

describe('ChatBackgroundService', () => {
  it('sanitizes and defaults', () => {
    expect(sanitizeChatBg(null)).toEqual(DEFAULT_CHAT_BG);
    expect(
      sanitizeChatBg({
        mode: 'solid',
        solidColor: '#ff0000',
        blur: 99,
        opacity: 2,
      }),
    ).toEqual({
      mode: 'solid',
      solidColor: '#ff0000',
      imageUrl: null,
      blur: 40,
      opacity: 1,
    });
    expect(sanitizeChatBg({ mode: 'image', imageUrl: 'http://evil' }).imageUrl).toBeNull();
  });

  it('preserves global blur and migrates panel blur with the center value first', () => {
    expect(sanitizeChatBg({ mode: 'image', blur: 8 }).blur).toBe(8);
    expect(sanitizeChatBg({ blurLeft: 4, blurCenter: 12, blurRight: 20 }).blur).toBe(12);
    expect(sanitizeChatBg({ blur: 0, blurCenter: 12 }).blur).toBe(0);
    expect(sanitizeChatBg({ blurLeft: 4, blurRight: 20 }).blur).toBe(4);
    expect(sanitizeChatBg({ blurRight: 20 }).blur).toBe(20);
    expect(sanitizeChatBg({ blur: -1 }).blur).toBe(0);
    expect(sanitizeChatBg({ blur: NaN, blurCenter: 8 }).blur).toBe(8);
    expect(sanitizeChatBg({ blur: Infinity }).blur).toBe(8);
  });

  it('persists set/reset to disk', () => {
    const root = tmpRoot();
    const file = path.join(root, 'chat-background.json');
    const images = path.join(root, 'images');
    const s = new ChatBackgroundService(file, images);
    expect(s.get()).toEqual(PRESET_DEFAULTS);
    expect(s.set({ mode: 'solid', solidColor: '#abcdef', blur: 8, opacity: 0.5 })).toMatchObject({
      mode: 'solid',
      solidColor: '#abcdef',
      blur: 8,
      opacity: 0.5,
    });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).mode).toBe('solid');
    expect(s.reset()).toEqual(PRESET_DEFAULTS);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).mode).toBe('image');
  });

  it('loads legacy settings and persists only global blur on the next update', () => {
    const root = tmpRoot();
    const file = path.join(root, 'chat-background.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ mode: 'image', blurLeft: 3, blurCenter: 7, blurRight: 9 }),
    );
    const service = new ChatBackgroundService(file, path.join(root, 'images'));
    expect(service.get().blur).toBe(7);
    service.set({ opacity: 0.42 });
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved).toMatchObject({ blur: 7, opacity: 0.42 });
    expect(saved).not.toHaveProperty('blurLeft');
    expect(saved).not.toHaveProperty('blurCenter');
    expect(saved).not.toHaveProperty('blurRight');
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
    expect(st.imageUrl).toMatch(/^chat-asset:\/\/images\/panel-bg\.[\w-]+\.png$/);
    expect(fs.readFileSync(path.join(images, new URL(st.imageUrl!).pathname), 'utf8')).toBe(
      'fake-png',
    );
    s.reset();
    expect(fs.readdirSync(images)).toEqual([]);
  });

  it('replacing an image changes its URL and retains only the latest file', async () => {
    const { dialog } = jest.requireMock('electron') as {
      dialog: { showOpenDialog: jest.Mock };
    };
    const root = tmpRoot();
    const file = path.join(root, 'chat-background.json');
    const images = path.join(root, 'images');
    const src = path.join(root, 'src.png');
    const service = new ChatBackgroundService(file, images);
    dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [src] });
    fs.writeFileSync(src, 'first-png');
    const first = await service.pickImage();
    fs.writeFileSync(src, 'second-png');
    const second = await service.pickImage();
    expect(second.imageUrl).not.toBe(first.imageUrl);
    expect(fs.readdirSync(images)).toHaveLength(1);
    expect(fs.readFileSync(path.join(images, new URL(second.imageUrl!).pathname), 'utf8')).toBe(
      'second-png',
    );
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).imageUrl).toBe(second.imageUrl);
    fs.unlinkSync(src);
    expect(new ChatBackgroundService(file, images).get()).toEqual(second);
    expect(fs.readdirSync(images)).toHaveLength(1);
  });

  it('restores existing cached images on startup', () => {
    const root = tmpRoot();
    const file = path.join(root, 'chat-background.json');
    const images = path.join(root, 'images');
    fs.mkdirSync(images);
    fs.writeFileSync(path.join(images, 'panel-bg.png'), 'old-png');
    fs.writeFileSync(
      file,
      JSON.stringify({ mode: 'image', imageUrl: 'chat-asset://images/panel-bg.png' }),
    );
    expect(new ChatBackgroundService(file, images).get().imageUrl).toBe(
      'chat-asset://images/panel-bg.png',
    );
    expect(fs.readdirSync(images)).toEqual(['panel-bg.png']);
  });

  it('recovers the temporary image from the previous no-cache implementation', () => {
    const root = tmpRoot();
    const file = path.join(root, 'chat-background.json');
    const images = path.join(root, 'images');
    fs.mkdirSync(images);
    fs.writeFileSync(path.join(images, 'panel-bg.png'), 'old-png');
    fs.writeFileSync(
      file,
      JSON.stringify({ mode: 'default', imageUrl: null, blur: 0, opacity: 0.39 }),
    );
    const service = new ChatBackgroundService(file, images);
    expect(service.get()).toMatchObject({
      mode: 'image',
      imageUrl: 'chat-asset://images/panel-bg.png',
      blur: 0,
      opacity: 0.39,
    });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(service.get());
  });

  it('uses the preset at first run and resets to it without deleting it', async () => {
    const { dialog } = jest.requireMock('electron') as { dialog: { showOpenDialog: jest.Mock } };
    const root = tmpRoot();
    const file = path.join(root, 'chat-background.json');
    const images = path.join(root, 'images');
    const preset = path.join(root, 'app-assets', 'nomi-preset.jpg');
    fs.mkdirSync(path.dirname(preset));
    fs.writeFileSync(preset, 'preset');
    const service = new ChatBackgroundService(file, images, preset);
    const defaults = { ...DEFAULT_CHAT_BG, mode: 'image', imageUrl: CHAT_BG_PRESET_URL };
    expect(service.get()).toEqual(defaults);
    const source = path.join(root, 'custom.png');
    fs.writeFileSync(source, 'custom');
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [source] });
    service.set({ blur: 17, opacity: 0.6 });
    const selected = await service.pickImage();
    expect(selected).toMatchObject({ blur: 17, opacity: 0.6 });
    expect(selected.imageUrl).not.toBe(CHAT_BG_PRESET_URL);
    expect(new ChatBackgroundService(file, images, preset).get()).toEqual(selected);
    expect(service.reset()).toEqual(defaults);
    expect(fs.readFileSync(preset, 'utf8')).toBe('preset');
    expect(fs.readdirSync(images)).toEqual([]);
    expect(new ChatBackgroundService(file, images, preset).get()).toEqual(defaults);
  });

  it('falls back to the preset when the saved custom image is missing or unsafe', () => {
    const root = tmpRoot();
    const file = path.join(root, 'chat-background.json');
    const images = path.join(root, 'images');
    const preset = path.join(root, 'app-assets', 'nomi-preset.jpg');
    fs.mkdirSync(path.dirname(preset));
    fs.writeFileSync(preset, 'preset');
    for (const imageUrl of [
      'chat-asset://images/panel-bg.missing.png',
      'chat-asset://images/%2e%2e%2fsecret.png',
      'chat-asset://images/panel-bg.%ZZ.png',
      'https://example.com/image.png',
    ]) {
      fs.writeFileSync(file, JSON.stringify({ mode: 'image', imageUrl, blur: 0, opacity: 0.75 }));
      expect(new ChatBackgroundService(file, images, preset).get()).toMatchObject({
        imageUrl: CHAT_BG_PRESET_URL,
        blur: 0,
        opacity: 0.75,
      });
    }
  });

  it('uses the bundled preset without a local preset or image directory', () => {
    const root = tmpRoot();
    const file = path.join(root, 'bg.json');
    const images = path.join(root, 'chat', 'images');
    const service = new ChatBackgroundService(file, images);
    expect(service.get()).toEqual(PRESET_DEFAULTS);
    expect(fs.existsSync(path.join(root, 'chat'))).toBe(false);
    expect(new ChatBackgroundService(file, images).get()).toEqual(PRESET_DEFAULTS);
  });

  it('does not use a userData preset when the bundled resource is missing', () => {
    const root = tmpRoot();
    const file = path.join(root, 'bg.json');
    const images = path.join(root, 'chat', 'images');
    const localPreset = path.join(root, 'chat', 'presets', 'background.jpg');
    fs.mkdirSync(path.dirname(localPreset), { recursive: true });
    fs.writeFileSync(localPreset, 'obsolete-local-preset');
    fs.writeFileSync(file, JSON.stringify(PRESET_DEFAULTS));
    const service = new ChatBackgroundService(file, images, path.join(root, 'missing.jpg'));
    expect(service.get()).toEqual(DEFAULT_CHAT_BG);
    expect(fs.readFileSync(localPreset, 'utf8')).toBe('obsolete-local-preset');
  });

  it('keeps the previous cached image when a replacement cannot be persisted', async () => {
    const { dialog } = jest.requireMock('electron') as { dialog: { showOpenDialog: jest.Mock } };
    const root = tmpRoot();
    const file = path.join(root, 'bg.json');
    const images = path.join(root, 'images');
    const source = path.join(root, 'source.png');
    const service = new ChatBackgroundService(file, images);
    fs.writeFileSync(source, 'first');
    dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [source] });
    const previous = await service.pickImage();
    fs.writeFileSync(source, 'replacement');
    const rename = jest.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('disk unavailable');
    });
    try {
      await expect(service.pickImage()).rejects.toThrow('disk unavailable');
      expect(service.get()).toEqual(previous);
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(previous);
      expect(fs.readdirSync(images)).toHaveLength(1);
      expect(fs.readFileSync(path.join(images, new URL(previous.imageUrl!).pathname), 'utf8')).toBe(
        'first',
      );
    } finally {
      rename.mockRestore();
    }
  });

  it('leaves settings intact on cancel or invalid selection', async () => {
    const { dialog } = jest.requireMock('electron') as { dialog: { showOpenDialog: jest.Mock } };
    const root = tmpRoot();
    const service = new ChatBackgroundService(
      path.join(root, 'bg.json'),
      path.join(root, 'images'),
    );
    const before = service.set({ blur: 0, opacity: 1 });
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await service.pickImage()).toEqual(before);
    dialog.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [path.join(root, 'bad.txt')],
    });
    await expect(service.pickImage()).rejects.toThrow('unsupported image type');
    expect(service.get()).toEqual(before);
  });
});
