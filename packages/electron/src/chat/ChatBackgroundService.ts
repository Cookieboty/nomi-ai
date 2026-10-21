/**
 * 对话主面板背景（设置 → 通用 → 聊天背景）：纯色或图片，可选模糊与透明度，重置回默认。
 * 仅作用于对话主面板（.chat-container），不改整窗 / OS。
 * 持久化：userData/chat-background.json；图片落到 userData/chat/images/panel-bg.*（chat-asset://）。
 */
import fs from 'node:fs';
import path from 'node:path';

import { BrowserWindow, dialog, ipcMain } from 'electron';

import { t as tr } from '../i18n';

export type ChatBgMode = 'default' | 'solid' | 'image';

export interface ChatBackgroundState {
  mode: ChatBgMode;
  /** #rrggbb，mode=solid 时使用 */
  solidColor: string;
  /** chat-asset://images/panel-bg.ext，mode=image 时使用 */
  imageUrl: string | null;
  /** 背景层模糊半径 px（0–40） */
  blur: number;
  /** 背景层不透明度 0.05–1 */
  opacity: number;
}

export const CHAT_BG_FILE = 'chat-background.json';
export const CHAT_BG_IMAGE_STEM = 'panel-bg';

export const DEFAULT_CHAT_BG: ChatBackgroundState = {
  mode: 'default',
  solidColor: '#fff6ec',
  imageUrl: null,
  blur: 0,
  opacity: 0.35,
};

const MODES: ChatBgMode[] = ['default', 'solid', 'image'];
const HEX = /^#[0-9a-fA-F]{6}$/;
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function sanitizeChatBg(raw: unknown): ChatBackgroundState {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<ChatBackgroundState>;
  const mode = MODES.includes(o.mode as ChatBgMode) ? (o.mode as ChatBgMode) : 'default';
  const solidColor =
    typeof o.solidColor === 'string' && HEX.test(o.solidColor)
      ? o.solidColor
      : DEFAULT_CHAT_BG.solidColor;
  const imageUrl =
    typeof o.imageUrl === 'string' && o.imageUrl.startsWith('chat-asset://images/')
      ? o.imageUrl
      : null;
  const blur = typeof o.blur === 'number' && Number.isFinite(o.blur) ? clamp(o.blur, 0, 40) : 0;
  const opacity =
    typeof o.opacity === 'number' && Number.isFinite(o.opacity)
      ? clamp(o.opacity, 0.05, 1)
      : DEFAULT_CHAT_BG.opacity;
  return { mode, solidColor, imageUrl, blur, opacity };
}

export class ChatBackgroundService {
  private state: ChatBackgroundState = { ...DEFAULT_CHAT_BG };

  constructor(
    private readonly file: string,
    private readonly imagesDir: string,
  ) {
    try {
      this.state = sanitizeChatBg(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      /* first run */
    }
  }

  get(): ChatBackgroundState {
    return { ...this.state };
  }

  set(patch: unknown): ChatBackgroundState {
    const next = sanitizeChatBg({
      ...this.state,
      ...(patch && typeof patch === 'object' ? patch : {}),
    });
    // 切回 default / solid 时保留 imageUrl 文件，方便再切回 image；reset 才删
    this.state = next;
    this.persist();
    this.broadcast();
    return this.get();
  }

  reset(): ChatBackgroundState {
    this.removeImageFiles();
    this.state = { ...DEFAULT_CHAT_BG };
    this.persist();
    this.broadcast();
    return this.get();
  }

  async pickImage(parent?: BrowserWindow | null): Promise<ChatBackgroundState> {
    const opts: Electron.OpenDialogOptions = {
      title: tr('选择聊天背景图片'),
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
    this.removeImageFiles();
    const destName = `${CHAT_BG_IMAGE_STEM}${ext}`;
    const dest = path.join(this.imagesDir, destName);
    fs.copyFileSync(src, dest);
    this.state = sanitizeChatBg({
      ...this.state,
      mode: 'image',
      imageUrl: `chat-asset://images/${destName}`,
    });
    this.persist();
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
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2), 'utf8');
  }

  private broadcast(): void {
    const s = this.get();
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('chat-bg:changed', s);
    }
  }

  private removeImageFiles(): void {
    try {
      if (!fs.existsSync(this.imagesDir)) return;
      for (const name of fs.readdirSync(this.imagesDir)) {
        if (name.startsWith(CHAT_BG_IMAGE_STEM + '.')) {
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
