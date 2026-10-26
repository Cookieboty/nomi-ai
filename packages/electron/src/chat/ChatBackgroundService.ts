/**
 * 图片主题背景：图片、模糊与透明度持久化（chat-background.json + userData/chat/images）。
 * 是否显示由主题 pref === 'image' 决定，这里只管图片与参数；用户图片优先，缺失时回退内置预设。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  CHAT_BG_IMAGE_URL_PREFIX,
  CHAT_BG_ERROR,
  CHAT_BG_MAX_BYTES,
  CHAT_BG_MAX_EDGE,
  CHAT_BG_PRESET_URL,
  DEFAULT_CHAT_BG,
  sanitizeChatBg,
  type ChatBackgroundState,
} from '@nomi-ai/types';
import { BrowserWindow, dialog, ipcMain, nativeImage } from 'electron';

import { t as tr } from '../i18n';
import { writePrivateFileAtomic } from '../utils/privateFile';

import { getChatBackgroundPresetFile } from './backgroundPreset';

export {
  CHAT_BG_PRESET_URL,
  DEFAULT_CHAT_BG,
  sanitizeChatBg,
  type ChatBackgroundState,
} from '@nomi-ai/types';

export const CHAT_BG_FILE = 'chat-background.json';
export const CHAT_BG_IMAGE_STEM = 'panel-bg';

const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

export class ChatBackgroundService {
  private state: ChatBackgroundState;
  constructor(
    private readonly file: string,
    private readonly imagesDir: string,
    private readonly presetFile = getChatBackgroundPresetFile(),
  ) {
    let saved: unknown = null;
    try {
      saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      /* first run */
    }
    this.state = this.withValidImage(sanitizeChatBg(saved));
    this.persist();
  }

  get(): ChatBackgroundState {
    return { ...this.state };
  }

  /** 合并补丁并重新校验图片；图片已失效（被删 / 移走）时回退预设。传空补丁即可触发重新校验。 */
  set(patch: unknown): ChatBackgroundState {
    const next = this.withValidImage(
      sanitizeChatBg({ ...this.state, ...(patch && typeof patch === 'object' ? patch : {}) }),
    );
    const previous = this.state;
    this.state = next;
    try {
      this.persist();
    } catch (error) {
      this.state = previous;
      throw error;
    }
    this.broadcast();
    return this.get();
  }

  reset(): ChatBackgroundState {
    const next = this.set({ ...DEFAULT_CHAT_BG, imageUrl: this.presetUrl() });
    this.removeImageFiles();
    return next;
  }

  async pickImage(parent?: BrowserWindow | null): Promise<ChatBackgroundState> {
    const opts: Electron.OpenDialogOptions = {
      title: tr('electron.common.choose-chat-background-image'),
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    };
    const r = parent
      ? await dialog.showOpenDialog(parent, opts)
      : await dialog.showOpenDialog(opts);
    if (r.canceled || !r.filePaths[0]) return this.get();
    return this.importImage(r.filePaths[0]);
  }

  /**
   * 校验大小 → 最长边超过 CHAT_BG_MAX_EDGE 则等比缩小（PNG 仍存 PNG 保留透明，其余存 jpg），
   * 否则原样复制；GIF 不缩以免丢动画。
   */
  async importImage(src: string): Promise<ChatBackgroundState> {
    let ext = path.extname(src).toLowerCase();
    if (!IMG_EXT.has(ext)) {
      throw new Error(`${CHAT_BG_ERROR.unsupported}: unsupported image type: ${ext}`);
    }
    const { size } = await fsp.stat(src);
    if (size > CHAT_BG_MAX_BYTES) {
      throw new Error(
        `${CHAT_BG_ERROR.tooLarge}: image too large: ${size} bytes (max ${CHAT_BG_MAX_BYTES})`,
      );
    }
    await fsp.mkdir(this.imagesDir, { recursive: true });
    let resized: Buffer | null = null;
    if (ext !== '.gif') {
      const img = nativeImage.createFromBuffer(await fsp.readFile(src));
      const { width, height } = img.isEmpty() ? { width: 0, height: 0 } : img.getSize();
      if (Math.max(width, height) > CHAT_BG_MAX_EDGE) {
        const out = img.resize(
          width >= height
            ? { width: CHAT_BG_MAX_EDGE, quality: 'best' }
            : { height: CHAT_BG_MAX_EDGE, quality: 'best' },
        );
        if (ext === '.png') resized = out.toPNG();
        else {
          resized = out.toJPEG(85);
          ext = '.jpg';
        }
      }
    }
    const destName = `${CHAT_BG_IMAGE_STEM}.${randomUUID()}${ext}`;
    const dest = path.join(this.imagesDir, destName);
    if (resized) await fsp.writeFile(dest, resized);
    else await fsp.copyFile(src, dest);
    const previous = this.state;
    this.state = sanitizeChatBg({ ...this.state, imageUrl: CHAT_BG_IMAGE_URL_PREFIX + destName });
    try {
      this.persist();
    } catch (error) {
      this.state = previous;
      try {
        fs.unlinkSync(dest);
      } catch {
        /* 保留原始错误 */
      }
      throw error;
    }
    this.removeImageFiles(destName);
    this.broadcast();
    return this.get();
  }

  registerIpc(): void {
    ipcMain.removeHandler('chat-bg:get');
    ipcMain.removeHandler('chat-bg:set');
    ipcMain.removeHandler('chat-bg:reset');
    ipcMain.removeHandler('chat-bg:pick-image');
    ipcMain.handle('chat-bg:get', () => this.get());
    ipcMain.handle('chat-bg:set', (_e, patch: unknown) => this.set(patch));
    ipcMain.handle('chat-bg:reset', () => this.reset());
    ipcMain.handle('chat-bg:pick-image', (e) => {
      const win = BrowserWindow.fromWebContents(e.sender);
      return this.pickImage(win);
    });
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writePrivateFileAtomic(this.file, JSON.stringify(this.state, null, 2));
  }

  private presetUrl(): string | null {
    return this.validImageUrl(CHAT_BG_PRESET_URL);
  }

  private withValidImage(s: ChatBackgroundState): ChatBackgroundState {
    return { ...s, imageUrl: this.validImageUrl(s.imageUrl) ?? this.presetUrl() };
  }

  private validImageUrl(rawUrl: string | null): string | null {
    if (!rawUrl) return null;
    try {
      const url = new URL(rawUrl);
      const name = decodeURIComponent(url.pathname.slice(1));
      const isPreset = rawUrl === CHAT_BG_PRESET_URL;
      if (
        !isPreset &&
        (url.protocol !== 'chat-asset:' ||
          url.hostname !== 'images' ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          name.includes('\\') ||
          path.basename(name) !== name ||
          !name.startsWith(CHAT_BG_IMAGE_STEM + '.') ||
          !IMG_EXT.has(path.extname(name).toLowerCase()))
      )
        return null;
      const file = isPreset ? this.presetFile : path.join(this.imagesDir, name);
      const realFile = fs.realpathSync(file);
      const realDir = fs.realpathSync(isPreset ? path.dirname(this.presetFile) : this.imagesDir);
      return realFile.startsWith(realDir + path.sep) && fs.statSync(realFile).isFile()
        ? rawUrl
        : null;
    } catch {
      return null;
    }
  }

  private broadcast(): void {
    const s = this.get();
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('chat-bg:changed', s);
    }
  }

  private removeImageFiles(keep?: string): void {
    try {
      if (!fs.existsSync(this.imagesDir)) return;
      for (const name of fs.readdirSync(this.imagesDir)) {
        if (name !== keep && name.startsWith(CHAT_BG_IMAGE_STEM + '.')) {
          try {
            fs.unlinkSync(path.join(this.imagesDir, name));
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore */
    }
  }
}
