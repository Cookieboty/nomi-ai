/**
 * 图片主题背景：图片、模糊与透明度持久化（chat-background.json + userData/chat/images）。
 * 是否显示由主题 pref === 'image' 决定，这里只管图片与参数；用户图片优先，缺失时回退内置预设。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import type { DialogParent, HostPorts } from '@nomi-ai/host-ports';
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

import type { AppEvents } from '../core/appEvents';
import { t as tr } from '../i18n';
import { createMainLogger } from '../utils/log';
import { writePrivateFileAtomicAsync } from '../utils/privateFile';

const log = createMainLogger('chat-background');

export {
  CHAT_BG_PRESET_URL,
  DEFAULT_CHAT_BG,
  sanitizeChatBg,
  type ChatBackgroundState,
} from '@nomi-ai/types';

export const CHAT_BG_FILE = 'chat-background.json';
export const CHAT_BG_IMAGE_STEM = 'panel-bg';

const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

export interface ChatBackgroundDeps {
  /** 设置文件（userData/chat-background.json） */
  file: string;
  /** 用户图片目录（userData/chat/images） */
  imagesDir: string;
  /** 内置预设图（getChatBackgroundPresetFile） */
  presetFile: string;
  /** 选择图片（dialogs）、缩放大图（image） */
  ports: Pick<HostPorts, 'dialogs' | 'image'>;
  /** 通知界面（`chatBg.changed` 发给所有窗口） */
  events: AppEvents;
}

export class ChatBackgroundService {
  private state: ChatBackgroundState;
  /** 改动按顺序执行：每次都基于上一次落盘后的状态合并，失败只回滚自己这一次 */
  private ops: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  private readonly imagesDir: string;
  private readonly presetFile: string;
  private readonly ports: ChatBackgroundDeps['ports'];
  private readonly events: AppEvents;
  constructor(deps: ChatBackgroundDeps) {
    this.file = deps.file;
    this.imagesDir = deps.imagesDir;
    this.presetFile = deps.presetFile;
    this.ports = deps.ports;
    this.events = deps.events;
    let saved: unknown = null;
    try {
      saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      /* first run */
    }
    this.state = this.withValidImage(sanitizeChatBg(saved));
    // 启动落盘进同一串行队列，便于测试 await flush，也避免与 set/import 抢写（#154）
    // 启动落盘失败不影响内存态（下次 set 会重写）；必须接住，否则成为未处理的 rejection
    void this.serial(() => this.persistAsync()).catch((error: unknown) => {
      log.warn('initial persist failed', error);
    });
  }

  /** 等到队列里的 persist / import 都结束（单测在 mock rename 前调用） */
  flush(): Promise<void> {
    return this.serial(async () => undefined);
  }

  get(): ChatBackgroundState {
    return { ...this.state };
  }

  /** 合并补丁并重新校验图片；图片已失效（被删 / 移走）时回退预设。传空补丁即可触发重新校验。 */
  set(patch: unknown): Promise<ChatBackgroundState> {
    return this.serial(() => this.apply(patch));
  }

  reset(): Promise<ChatBackgroundState> {
    return this.serial(async () => {
      const next = await this.apply({ ...DEFAULT_CHAT_BG, imageUrl: this.presetUrl() });
      this.removeImageFiles();
      return next;
    });
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.ops.catch(() => undefined).then(fn);
    this.ops = run;
    return run;
  }

  private async apply(patch: unknown): Promise<ChatBackgroundState> {
    const next = this.withValidImage(
      sanitizeChatBg({ ...this.state, ...(patch && typeof patch === 'object' ? patch : {}) }),
    );
    const previous = this.state;
    this.state = next;
    try {
      await this.persistAsync();
    } catch (error) {
      this.state = previous;
      throw error;
    }
    this.broadcast();
    return this.get();
  }

  /** 选择图片并导入；`parent` 是对话框挂靠的界面（IPC 从对话窗口发起时为 `chat`） */
  async pickImage(parent: DialogParent = 'none'): Promise<ChatBackgroundState> {
    const [picked] = await this.ports.dialogs.pickFiles({
      title: tr('electron.common.choose-chat-background-image'),
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
      parent,
    });
    if (!picked) return this.get();
    return this.importImage(picked);
  }

  /**
   * 校验大小 → 最长边超过 CHAT_BG_MAX_EDGE 则等比缩小（PNG 仍存 PNG 保留透明，其余存 jpg），
   * 否则原样复制；GIF 不缩以免丢动画。
   */
  importImage(src: string): Promise<ChatBackgroundState> {
    return this.serial(() => this.importNow(src));
  }

  private async importNow(src: string): Promise<ChatBackgroundState> {
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
    let resized: Uint8Array | null = null;
    if (ext !== '.gif') {
      const data = await fsp.readFile(src);
      const { width, height } = (await this.ports.image.size(data)) ?? { width: 0, height: 0 };
      if (Math.max(width, height) > CHAT_BG_MAX_EDGE) {
        const edge = width >= height ? { width: CHAT_BG_MAX_EDGE } : { height: CHAT_BG_MAX_EDGE };
        if (ext === '.png')
          resized = await this.ports.image.resize(data, { ...edge, format: 'png' });
        else {
          resized = await this.ports.image.resize(data, { ...edge, format: 'jpeg', quality: 85 });
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
      await this.persistAsync();
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

  /** 界面操作触发的写入：Windows 文件被占用时退避等待不挡主进程（#154） */
  private async persistAsync(): Promise<void> {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    await writePrivateFileAtomicAsync(this.file, JSON.stringify(this.state, null, 2));
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
    this.events.publish('chatBg.changed', this.get());
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
