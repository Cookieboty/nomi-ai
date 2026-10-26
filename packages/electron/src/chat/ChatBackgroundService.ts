/**
 * 全局图片主题：图片、毛玻璃与透明度，不改 OS。
 * 图片与参数持久化，用户图片优先于独立预设。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { BrowserWindow, dialog, ipcMain } from 'electron';

import { t as tr } from '../i18n';
import { writePrivateFileAtomic } from '../utils/privateFile';

import { CHAT_BG_PRESET_URL, getChatBackgroundPresetFile } from './backgroundPreset';

export { CHAT_BG_PRESET_URL } from './backgroundPreset';

export type ChatBgMode = 'default' | 'solid' | 'image';

export interface ChatBackgroundState {
  mode: ChatBgMode;
  /** #rrggbb，mode=solid 时使用 */
  solidColor: string;
  /** chat-asset://images/panel-bg.ext，mode=image 时使用 */
  imageUrl: string | null;
  blur: number;
  /** 背景层不透明度 0.05–1 */
  opacity: number;
}

export const CHAT_BG_FILE = 'chat-background.json';
export const CHAT_BG_IMAGE_STEM = 'panel-bg';

export const DEFAULT_CHAT_BG: ChatBackgroundState = {
  mode: 'default',
  solidColor: '#fff8f1',
  imageUrl: null,
  blur: 8,
  opacity: 0.4,
};

const MODES: ChatBgMode[] = ['default', 'solid', 'image'];
const HEX = /^#[0-9a-fA-F]{6}$/;
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function sanitizeChatBg(raw: unknown): ChatBackgroundState {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<ChatBackgroundState> & {
    blurLeft?: unknown;
    blurCenter?: unknown;
    blurRight?: unknown;
  };
  const mode = MODES.includes(o.mode as ChatBgMode) ? (o.mode as ChatBgMode) : 'default';
  const solidColor =
    typeof o.solidColor === 'string' && HEX.test(o.solidColor)
      ? o.solidColor
      : DEFAULT_CHAT_BG.solidColor;
  const imageUrl =
    typeof o.imageUrl === 'string' &&
    (o.imageUrl.startsWith('chat-asset://images/') || o.imageUrl === CHAT_BG_PRESET_URL)
      ? o.imageUrl
      : null;
  const px = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, 40) : fallback;
  const blur = px(o.blur, px(o.blurCenter, px(o.blurLeft, px(o.blurRight, DEFAULT_CHAT_BG.blur))));
  const opacity =
    typeof o.opacity === 'number' && Number.isFinite(o.opacity)
      ? clamp(o.opacity, 0.05, 1)
      : DEFAULT_CHAT_BG.opacity;
  return {
    mode,
    solidColor,
    imageUrl,
    blur,
    opacity,
  };
}

export class ChatBackgroundService {
  private state: ChatBackgroundState = { ...DEFAULT_CHAT_BG };
  constructor(
    private readonly file: string,
    private readonly imagesDir: string,
    private readonly presetFile = getChatBackgroundPresetFile(),
  ) {
    this.state = this.defaults();
    try {
      const saved = JSON.parse(
        fs.readFileSync(file, 'utf8'),
      ) as Partial<ChatBackgroundState> | null;
      this.state = sanitizeChatBg(saved);
      if (saved?.mode === 'default' && saved.imageUrl == null) {
        const cached = this.latestCachedImage();
        if (cached) this.state.imageUrl = `chat-asset://images/${cached}`;
      }
    } catch {
      /* first run */
    }
    this.state.imageUrl = this.validImageUrl(this.state.imageUrl) ?? this.defaults().imageUrl;
    if (this.state.imageUrl) this.state.mode = 'image';
    else if (this.state.mode === 'image') this.state.mode = 'default';
    this.persist();
  }

  get(): ChatBackgroundState {
    return { ...this.state };
  }

  set(patch: unknown): ChatBackgroundState {
    const next = sanitizeChatBg({
      ...this.state,
      ...(patch && typeof patch === 'object' ? patch : {}),
    });
    next.imageUrl = this.validImageUrl(next.imageUrl) ?? this.defaults().imageUrl;
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
    const next = this.set(this.defaults());
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
    const src = r.filePaths[0];
    const ext = path.extname(src).toLowerCase();
    if (!IMG_EXT.has(ext)) throw new Error(`unsupported image type: ${ext}`);
    fs.mkdirSync(this.imagesDir, { recursive: true });
    const destName = `${CHAT_BG_IMAGE_STEM}.${randomUUID()}${ext}`;
    const dest = path.join(this.imagesDir, destName);
    fs.copyFileSync(src, dest);
    const previous = this.state;
    this.state = sanitizeChatBg({
      ...this.state,
      mode: 'image',
      imageUrl: `chat-asset://images/${destName}`,
    });
    try {
      this.persist();
    } catch (error) {
      this.state = previous;
      fs.unlinkSync(dest);
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

  private defaults(): ChatBackgroundState {
    return {
      ...DEFAULT_CHAT_BG,
      ...(this.validImageUrl(CHAT_BG_PRESET_URL)
        ? { mode: 'image', imageUrl: CHAT_BG_PRESET_URL }
        : {}),
    };
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

  private latestCachedImage(): string | null {
    try {
      return (
        fs
          .readdirSync(this.imagesDir)
          .filter((name) => this.validImageUrl(`chat-asset://images/${name}`))
          .sort(
            (left, right) =>
              fs.statSync(path.join(this.imagesDir, right)).mtimeMs -
              fs.statSync(path.join(this.imagesDir, left)).mtimeMs,
          )[0] ?? null
      );
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
