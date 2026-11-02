/**
 * 素材库：所有生成的图片（Nomi 的 image_generate、编程助手生成后复制过来的图片）统一在这里管理。
 *
 * - 图片都在 userData/chat/images（经 chat-asset 协议给视图）；来源写在文件名前缀里：
 *   `nomi-…`（Nomi 生成；早期的 `gen-…` 也算 Nomi）、`grok-…` / `codex-…` 等（编程助手生成）、
 *   `user-…`（用户在对话里发送的原图，经 chatAssets.import 存进来，模型可拿它改图 / 当参考图）。
 *   同目录里的对话背景（`<stem>.<uuid>.ext`、`panel-bg.jpg`）不是生成的图片，不列。
 * - 模型 / 提示词 / 会话等说明另存在 userData/chat/assets.json（只给 Nomi 生成的写；编程助手的只有来源与时间）。
 * - 删除移到系统废纸篓（可恢复）；「在文件夹中显示」经宿主 shell 端口。
 */
import fs from 'node:fs';
import path from 'node:path';

import { t } from '../i18n';
import { ensurePrivateDir, writePrivateFileAtomic } from '../utils/privateFile';

/** 生成图片的文件名：<来源>-<编号>.<扩展名> */
export const ASSET_FILE = /^([a-z][a-z0-9]*)-[A-Za-z0-9._-]+\.(png|jpe?g|webp|gif)$/i;
/** 早期 Nomi 生成的图片前缀 */
const LEGACY_SOURCE: Record<string, string> = { gen: 'nomi' };
/** 认得的来源（其余前缀不是生成的图片，不列） */
export const ASSET_SOURCES = [
  'nomi',
  'grok',
  'codex',
  'claude',
  'gemini',
  'dsh',
  'qwen',
  'kimi',
  'opencode',
  'copilot',
  'user',
] as const;
export type AssetSource = (typeof ASSET_SOURCES)[number];

export interface AssetMeta {
  /** `供应商/模型` */
  model?: string;
  prompt?: string;
  /** 画幅（1:1 / 3:2 …；没指定为空 = 模型默认） */
  aspect?: string;
  /** 改图：改自素材库里的哪张 */
  editedFrom?: string;
  /** 参考图生成：参考了素材库里的哪几张 */
  references?: string[];
  conversationId?: string;
}

export interface AssetItem extends AssetMeta {
  /** 文件名（也是 id） */
  file: string;
  url: string;
  source: AssetSource;
  createdAt: number;
  bytes: number;
}

/** 用户发送的原图上限（解码后） */
export const ASSET_IMPORT_MAX_BYTES = 20 * 1024 * 1024;

export type AssetImportMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

const IMPORT_EXT: Record<AssetImportMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** 文件头与声明的类型一致（不信视图给的 mime） */
export function imageMagicMatches(mime: AssetImportMime, b: Uint8Array): boolean {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  switch (mime) {
    case 'image/png':
      return at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case 'image/jpeg':
      return at(0, 0xff, 0xd8, 0xff);
    case 'image/webp':
      return at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50);
    case 'image/gif':
      return at(0, 0x47, 0x49, 0x46, 0x38) && (at(4, 0x37, 0x61) || at(4, 0x39, 0x61));
    default:
      return false;
  }
}

export interface AssetLibraryDeps {
  /** userData/chat */
  chatRoot: string;
  showItemInFolder?: (p: string) => void;
  trashItem?: (p: string) => Promise<void>;
  /** 素材库有变化（生成 / 删除）：契约事件 chatAssets.changed */
  onChanged?: () => void;
  /** 另存为：系统保存框，取消返回 null */
  saveFile?: (defaultName: string) => Promise<string | null>;
  /**
   * 重新生成（组合根注入 image/imageGenerate.ts 的 generateImageAsset）：用原图的提示词 / 模型 / 画幅 /
   * 改图来源 / 参考图再生成一张，返回新图的文件名
   */
  generate?: (req: {
    prompt: string;
    aspect?: string;
    modelRef?: string;
    editFrom?: string;
    references?: string[];
  }) => Promise<string>;
}

/** 文件名 → 来源；不是生成的图片返回 null */
export function assetSourceOf(file: string): AssetSource | null {
  const m = ASSET_FILE.exec(file);
  if (!m) return null;
  const prefix = m[1]!.toLowerCase();
  const source = LEGACY_SOURCE[prefix] ?? prefix;
  return (ASSET_SOURCES as readonly string[]).includes(source) ? (source as AssetSource) : null;
}

export class AssetLibrary {
  constructor(private readonly d: AssetLibraryDeps) {}

  private get imagesDir(): string {
    return path.join(this.d.chatRoot, 'images');
  }

  private get metaFile(): string {
    return path.join(this.d.chatRoot, 'assets.json');
  }

  private readMeta(): Record<string, AssetMeta> {
    try {
      const v = JSON.parse(fs.readFileSync(this.metaFile, 'utf8')) as unknown;
      return v && typeof v === 'object' && !Array.isArray(v)
        ? (v as Record<string, AssetMeta>)
        : {};
    } catch {
      return {};
    }
  }

  private writeMeta(m: Record<string, AssetMeta>): void {
    ensurePrivateDir(this.d.chatRoot);
    writePrivateFileAtomic(this.metaFile, JSON.stringify(m));
  }

  /** 生成了一张图（Nomi 的 image_generate 调用）：记下模型 / 提示词 / 会话，并通知视图 */
  record(file: string, meta: AssetMeta): void {
    if (!assetSourceOf(file)) return;
    const m = this.readMeta();
    m[file] = {
      ...(meta.model ? { model: meta.model } : {}),
      ...(meta.prompt ? { prompt: clipPrompt(meta.prompt) } : {}),
      ...(meta.aspect ? { aspect: meta.aspect } : {}),
      ...(meta.editedFrom ? { editedFrom: meta.editedFrom } : {}),
      ...(meta.references?.length ? { references: meta.references.slice(0, 8) } : {}),
      ...(meta.conversationId ? { conversationId: meta.conversationId } : {}),
    };
    try {
      this.writeMeta(m);
    } catch {
      /* 说明写不进去不影响图片本身 */
    }
    this.d.onChanged?.();
  }

  /**
   * 用户在对话里发送的图片：原图存进素材库（来源 user），返回素材项。
   * 解码后超过 20 MB、或文件头与 mime 不符的拒绝；对话 id 记进说明。
   */
  async importImage(req: {
    mime: AssetImportMime;
    data: string;
    conversationId?: string;
  }): Promise<AssetItem> {
    const ext = IMPORT_EXT[req.mime];
    // base64 解码前先按长度估一下，避免超大字符串整块解码
    const maxMb = ASSET_IMPORT_MAX_BYTES / 1024 / 1024;
    if (
      typeof req.data !== 'string' ||
      req.data.length > Math.ceil(ASSET_IMPORT_MAX_BYTES / 3) * 4 + 4
    )
      throw new Error(t('electron.image.import-too-large', maxMb));
    const bytes = Buffer.from(req.data, 'base64');
    if (bytes.length > ASSET_IMPORT_MAX_BYTES)
      throw new Error(t('electron.image.import-too-large', maxMb));
    if (!ext || !imageMagicMatches(req.mime, bytes))
      throw new Error(t('electron.image.import-bad-format'));
    ensurePrivateDir(this.imagesDir);
    const file = `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    await fs.promises.writeFile(path.join(this.imagesDir, file), bytes, {
      mode: 0o600,
      flag: 'wx',
    });
    // record 会通知视图（chatAssets.changed）
    this.record(file, req.conversationId ? { conversationId: req.conversationId } : {});
    const item = this.list().find((x) => x.file === file);
    if (!item) throw new Error(t('electron.image.import-bad-format'));
    return item;
  }

  /** 全部生成的图片，新的在前 */
  list(): AssetItem[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.imagesDir);
    } catch {
      return [];
    }
    const meta = this.readMeta();
    const out: AssetItem[] = [];
    for (const file of names) {
      const source = assetSourceOf(file);
      if (!source) continue;
      let st: fs.Stats;
      try {
        st = fs.statSync(path.join(this.imagesDir, file));
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      out.push({
        file,
        url: `chat-asset://images/${file}`,
        source,
        createdAt: Math.round(createdAtOf(st)),
        bytes: st.size,
        ...(meta[file] ?? {}),
      });
    }
    return out.sort((a, b) => b.createdAt - a.createdAt || a.file.localeCompare(b.file));
  }

  /** 只接受素材库里的文件名（不让视图传任意路径） */
  private pathOf(file: string): string | null {
    if (typeof file !== 'string' || !assetSourceOf(file) || file !== path.basename(file))
      return null;
    return path.join(this.imagesDir, file);
  }

  /** 删除：移到系统废纸篓（没有废纸篓能力时直接删）；返回实际删掉的文件名 */
  async remove(files: readonly string[]): Promise<string[]> {
    const done: string[] = [];
    for (const f of files) {
      const p = this.pathOf(f);
      if (!p || !fs.existsSync(p)) continue;
      try {
        if (this.d.trashItem) await this.d.trashItem(p);
        else fs.unlinkSync(p);
        done.push(f);
      } catch {
        /* 删不掉的留着，界面照常显示 */
      }
    }
    if (done.length) {
      const m = this.readMeta();
      for (const f of done) delete m[f];
      try {
        this.writeMeta(m);
      } catch {
        /* ignore */
      }
      this.d.onChanged?.();
    }
    return done;
  }

  /** 重新生成：沿用原图记下的提示词 / 模型 / 画幅 / 改图来源 / 参考图；返回新图 */
  async regenerate(file: string): Promise<AssetItem> {
    if (!this.pathOf(file) || !this.d.generate)
      throw new Error(t('electron.image.no-prompt-to-regenerate'));
    const m = this.readMeta()[file];
    if (!m?.prompt) throw new Error(t('electron.image.no-prompt-to-regenerate'));
    const next = await this.d.generate({
      prompt: m.prompt,
      ...(m.aspect ? { aspect: m.aspect } : {}),
      ...(m.model ? { modelRef: m.model } : {}),
      ...(m.editedFrom ? { editFrom: m.editedFrom } : {}),
      ...(m.references?.length ? { references: m.references } : {}),
    });
    const item = this.list().find((x) => x.file === next);
    if (!item) throw new Error(t('electron.image.no-image-in-response', ''));
    return item;
  }

  /** 另存为：用户选位置后复制一份；取消返回 false */
  async saveAs(file: string): Promise<boolean> {
    const p = this.pathOf(file);
    if (!p || !fs.existsSync(p) || !this.d.saveFile) return false;
    const dest = await this.d.saveFile(file);
    if (!dest) return false;
    await fs.promises.copyFile(p, dest);
    return true;
  }

  /** 在文件管理器中定位 */
  reveal(file: string): boolean {
    const p = this.pathOf(file);
    if (!p || !fs.existsSync(p) || !this.d.showItemInFolder) return false;
    this.d.showItemInFolder(p);
    return true;
  }
}

/**
 * 生成时间：birthtime 与 mtime 取早的那个（birthtime 拿不到时为 0，用 mtime）。
 * Linux 的 birthtime 是真实创建时间，复制 / 还原的文件 mtime 可能更早；macOS 复制时 birthtime 是复制时刻。
 * 与 Go 版 chatassets.createdAt 一致。
 */
function createdAtOf(st: fs.Stats): number {
  const b = st.birthtimeMs;
  return b > 0 && b < st.mtimeMs ? b : st.mtimeMs;
}

/**
 * 素材库记下的提示词上限：与 image_generate 的 prompt 上限（4000）一致，合法提示词原样保存，
 * 重新生成发的就是首次生成时的全文（#225）。超长的异常输入才截断，且不切开代理对。
 */
export const ASSET_PROMPT_MAX = 4000;

function clipPrompt(s: string): string {
  if (s.length <= ASSET_PROMPT_MAX) return s;
  const end = /[\uD800-\uDBFF]/.test(s[ASSET_PROMPT_MAX - 1]!)
    ? ASSET_PROMPT_MAX - 1
    : ASSET_PROMPT_MAX;
  return s.slice(0, end);
}
