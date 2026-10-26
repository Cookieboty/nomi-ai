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
  nativeImage: {
    createFromBuffer: jest.fn(() => ({
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
    })),
  },
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CHAT_BG_ERROR, CHAT_BG_MAX_BYTES, CHAT_BG_MAX_EDGE } from '@nomi-ai/types';

import {
  ChatBackgroundService,
  CHAT_BG_PRESET_URL,
  DEFAULT_CHAT_BG,
  sanitizeChatBg,
} from '../../../src/chat/ChatBackgroundService';

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'chat-bg-'));
const PRESET_DEFAULTS = { ...DEFAULT_CHAT_BG, imageUrl: CHAT_BG_PRESET_URL };

describe('ChatBackgroundService', () => {
  it('sanitizes and defaults', () => {
    expect(sanitizeChatBg(null)).toEqual(DEFAULT_CHAT_BG);
    expect(sanitizeChatBg({ mode: 'solid', solidColor: '#ff0000', blur: 99, opacity: 2 })).toEqual({
      imageUrl: null,
      blur: 40,
      opacity: 1,
    });
    expect(sanitizeChatBg({ imageUrl: 'http://evil' }).imageUrl).toBeNull();
  });

  it('clamps blur and ignores removed per-panel blur fields', () => {
    expect(sanitizeChatBg({ blur: 8 }).blur).toBe(8);
    expect(sanitizeChatBg({ blur: -1 }).blur).toBe(0);
    expect(sanitizeChatBg({ blur: Infinity }).blur).toBe(DEFAULT_CHAT_BG.blur);
    expect(sanitizeChatBg({ blurLeft: 4, blurCenter: 12, blurRight: 20 }).blur).toBe(
      DEFAULT_CHAT_BG.blur,
    );
  });

  it('persists set/reset to disk', () => {
    const root = tmpRoot();
    const file = path.join(root, 'chat-background.json');
    const images = path.join(root, 'images');
    const s = new ChatBackgroundService(file, images);
    expect(s.get()).toEqual(PRESET_DEFAULTS);
    expect(s.set({ blur: 3, opacity: 0.5 })).toMatchObject({ blur: 3, opacity: 0.5 });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ blur: 3, opacity: 0.5 });
    expect(s.reset()).toEqual(PRESET_DEFAULTS);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(PRESET_DEFAULTS);
  });

  it('drops removed fields from saved settings', () => {
    const root = tmpRoot();
    const file = path.join(root, 'chat-background.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ mode: 'solid', solidColor: '#123456', blurCenter: 7, opacity: 0.42 }),
    );
    const service = new ChatBackgroundService(file, path.join(root, 'images'));
    expect(service.get()).toEqual({ ...PRESET_DEFAULTS, opacity: 0.42 });
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).sort()).toEqual([
      'blur',
      'imageUrl',
      'opacity',
    ]);
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

  it('does not adopt orphan cached images when none is saved', () => {
    const root = tmpRoot();
    const file = path.join(root, 'chat-background.json');
    const images = path.join(root, 'images');
    fs.mkdirSync(images);
    fs.writeFileSync(path.join(images, 'panel-bg.png'), 'old-png');
    fs.writeFileSync(file, JSON.stringify({ imageUrl: null, blur: 0, opacity: 0.39 }));
    expect(new ChatBackgroundService(file, images).get()).toEqual({
      imageUrl: CHAT_BG_PRESET_URL,
      blur: 0,
      opacity: 0.39,
    });
  });

  it('re-validates on an empty patch and falls back to the preset when the image vanished', async () => {
    const { dialog } = jest.requireMock('electron') as { dialog: { showOpenDialog: jest.Mock } };
    const root = tmpRoot();
    const images = path.join(root, 'images');
    const src = path.join(root, 'src.png');
    fs.writeFileSync(src, 'png');
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [src] });
    const service = new ChatBackgroundService(path.join(root, 'bg.json'), images);
    const picked = await service.pickImage();
    fs.unlinkSync(path.join(images, new URL(picked.imageUrl!).pathname));
    expect(service.set({}).imageUrl).toBe(CHAT_BG_PRESET_URL);
  });

  it('rejects images over the size limit without touching state', async () => {
    const root = tmpRoot();
    const images = path.join(root, 'images');
    const src = path.join(root, 'huge.png');
    fs.writeFileSync(src, '');
    fs.truncateSync(src, CHAT_BG_MAX_BYTES + 1);
    const service = new ChatBackgroundService(path.join(root, 'bg.json'), images);
    const before = service.get();
    await expect(service.importImage(src)).rejects.toThrow(CHAT_BG_ERROR.tooLarge);
    expect(service.get()).toEqual(before);
    expect(fs.existsSync(images)).toBe(false);
  });

  const mockDecoded = (width: number, height: number) => {
    const { nativeImage } = jest.requireMock('electron') as {
      nativeImage: { createFromBuffer: jest.Mock };
    };
    const resize = jest.fn(() => ({
      toJPEG: () => Buffer.from('small-jpg'),
      toPNG: () => Buffer.from('small-png'),
    }));
    nativeImage.createFromBuffer.mockReturnValueOnce({
      isEmpty: () => false,
      getSize: () => ({ width, height }),
      resize,
    });
    return resize;
  };
  const importAs = async (name: string) => {
    const root = tmpRoot();
    const images = path.join(root, 'images');
    const src = path.join(root, name);
    fs.writeFileSync(src, 'raw');
    const service = new ChatBackgroundService(path.join(root, 'bg.json'), images);
    const st = await service.importImage(src);
    return {
      st,
      saved: fs.readFileSync(path.join(images, new URL(st.imageUrl!).pathname), 'utf8'),
    };
  };

  it('downscales wide images to the max edge as jpg', async () => {
    const resize = mockDecoded(4000, 3000);
    const { st, saved } = await importAs('wide.jpeg');
    expect(resize).toHaveBeenCalledWith({ width: CHAT_BG_MAX_EDGE, quality: 'best' });
    expect(st.imageUrl).toMatch(/\.jpg$/);
    expect(saved).toBe('small-jpg');
  });

  it('downscales tall images by height', async () => {
    const resize = mockDecoded(1200, 6000);
    const { st } = await importAs('tall.webp');
    expect(resize).toHaveBeenCalledWith({ height: CHAT_BG_MAX_EDGE, quality: 'best' });
    expect(st.imageUrl).toMatch(/\.jpg$/);
  });

  it('keeps large png as png so transparency survives', async () => {
    mockDecoded(4000, 3000);
    const { st, saved } = await importAs('wide.png');
    expect(st.imageUrl).toMatch(/\.png$/);
    expect(saved).toBe('small-png');
  });

  it('keeps the original persist error when cleanup unlink also fails', async () => {
    const root = tmpRoot();
    const src = path.join(root, 'src.png');
    fs.writeFileSync(src, 'png');
    const service = new ChatBackgroundService(
      path.join(root, 'bg.json'),
      path.join(root, 'images'),
    );
    const rename = jest.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('disk unavailable');
    });
    const unlink = jest.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => {
      throw new Error('unlink failed');
    });
    try {
      await expect(service.importImage(src)).rejects.toThrow('disk unavailable');
    } finally {
      rename.mockRestore();
      unlink.mockRestore();
    }
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
    const defaults = { ...DEFAULT_CHAT_BG, imageUrl: CHAT_BG_PRESET_URL };
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
      fs.writeFileSync(file, JSON.stringify({ imageUrl, blur: 0, opacity: 0.75 }));
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
    await expect(service.pickImage()).rejects.toThrow(CHAT_BG_ERROR.unsupported);
    expect(service.get()).toEqual(before);
  });
});
