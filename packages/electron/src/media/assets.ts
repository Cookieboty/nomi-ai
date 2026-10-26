/**
 * 素材库（主进程）：图片按 sha256 去重存放在 userData/media/assets，索引在 userData/media/assets.json。
 * - 同一张图无论从哪里来只存一份；每次出现都记一条来源（refs）
 * - inLibrary 区分「在素材库里」与「只是对话里引用的文件」（生成图开关关闭时仍要能在对话里显示）
 * - 从素材库移除只清 inLibrary，文件保留（对话里可能还在引用）
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { AssetSource } from '@nomi-ai/gateway/media';

import { ensurePrivateDir, writePrivateFileAtomic } from '../utils/privateFile';

export interface AssetRef {
  source: AssetSource;
  at: number;
  conversationId?: string;
  taskId?: string;
  /** 远程图片的原始地址（chat_reply 等） */
  originUrl?: string;
}

export interface AssetRecord {
  id: string;
  sha256: string;
  mime: string;
  ext: string;
  bytes: number;
  createdAt: number;
  inLibrary: boolean;
  /** 最近一次入库时间；素材库按它倒序 */
  addedAt?: number;
  prompt?: string;
  modelId?: string;
  providerRef?: string;
  refs: AssetRef[];
}

export interface AssetView extends Omit<AssetRecord, 'refs'> {
  url: string;
  sources: AssetSource[];
}

export const MEDIA_ASSET_HOST = 'media';
const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
const MAX_REFS = 50;

export function extForMime(mime: string): string | null {
  return EXT[mime.toLowerCase()] ?? null;
}

/** 从文件头嗅探图片类型（上游有时不给或给错 mime） */
export function sniffMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp';
  if (buf.length >= 6 && buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  return null;
}

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export class AssetError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface AddAssetInput {
  data: Buffer;
  mime?: string;
  source: AssetSource;
  /** 是否放入素材库（由调用方按开关 / 用户操作决定）；已在库中的不会被 false 移出 */
  inLibrary: boolean;
  conversationId?: string;
  taskId?: string;
  originUrl?: string;
  prompt?: string;
  modelId?: string;
  providerRef?: string;
}

export class AssetLibrary {
  private records = new Map<string, AssetRecord>();
  private readonly dir: string;
  private readonly indexFile: string;

  constructor(
    root: string,
    private readonly now: () => number = Date.now,
  ) {
    this.dir = path.join(root, 'assets');
    this.indexFile = path.join(root, 'assets.json');
    ensurePrivateDir(root);
    ensurePrivateDir(this.dir);
    this.load();
  }

  get assetsDir(): string {
    return this.dir;
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')) as { assets?: AssetRecord[] };
      for (const r of raw.assets ?? [])
        if (r && typeof r.sha256 === 'string') this.records.set(r.id, r);
    } catch {
      /* 首次 / 损坏：从空开始 */
    }
  }

  private save(): void {
    writePrivateFileAtomic(
      this.indexFile,
      JSON.stringify({ version: 1, assets: [...this.records.values()] }, null, 2),
    );
  }

  fileName(r: Pick<AssetRecord, 'sha256' | 'ext'>): string {
    return `${r.sha256}.${r.ext}`;
  }

  filePath(r: Pick<AssetRecord, 'sha256' | 'ext'>): string {
    return path.join(this.dir, this.fileName(r));
  }

  urlOf(r: Pick<AssetRecord, 'sha256' | 'ext'>): string {
    return `chat-asset://${MEDIA_ASSET_HOST}/${this.fileName(r)}`;
  }

  view(r: AssetRecord): AssetView {
    const { refs, ...rest } = r;
    return { ...rest, url: this.urlOf(r), sources: [...new Set(refs.map((x) => x.source))] };
  }

  get(id: string): AssetRecord | undefined {
    return this.records.get(id);
  }

  bySha(hash: string): AssetRecord | undefined {
    return this.records.get(hash.slice(0, 32));
  }

  byOriginUrl(url: string): AssetRecord | undefined {
    for (const r of this.records.values()) if (r.refs.some((x) => x.originUrl === url)) return r;
    return undefined;
  }

  add(input: AddAssetInput): { asset: AssetRecord; created: boolean } {
    const sniffed = sniffMime(input.data);
    const mime = sniffed ?? input.mime ?? '';
    const ext = extForMime(mime);
    if (!ext) throw new AssetError('unsupported', `unsupported image type: ${mime || 'unknown'}`);
    const hash = sha256(input.data);
    const id = hash.slice(0, 32);
    const at = this.now();
    let rec = this.records.get(id);
    const created = !rec;
    if (!rec) {
      rec = {
        id,
        sha256: hash,
        mime,
        ext,
        bytes: input.data.length,
        createdAt: at,
        inLibrary: false,
        refs: [],
      };
      this.records.set(id, rec);
    }
    const file = this.filePath(rec);
    if (!fs.existsSync(file)) fs.writeFileSync(file, input.data, { mode: 0o600 });
    if (input.inLibrary && !rec.inLibrary) {
      rec.inLibrary = true;
      rec.addedAt = at;
    }
    rec.prompt ??= input.prompt;
    rec.modelId ??= input.modelId;
    rec.providerRef ??= input.providerRef;
    rec.refs.push({
      source: input.source,
      at,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.originUrl ? { originUrl: input.originUrl } : {}),
    });
    if (rec.refs.length > MAX_REFS) rec.refs.splice(0, rec.refs.length - MAX_REFS);
    this.save();
    return { asset: rec, created };
  }

  setInLibrary(id: string, inLibrary: boolean): AssetRecord {
    const rec = this.records.get(id);
    if (!rec) throw new AssetError('not_found', `asset not found: ${id}`);
    if (rec.inLibrary !== inLibrary) {
      rec.inLibrary = inLibrary;
      if (inLibrary) rec.addedAt = this.now();
      this.save();
    }
    return rec;
  }

  /** 彻底删除（素材库里的「删除」）：去掉索引与文件 */
  delete(id: string): boolean {
    const rec = this.records.get(id);
    if (!rec) return false;
    this.records.delete(id);
    try {
      fs.unlinkSync(this.filePath(rec));
    } catch {
      /* 文件已不在 */
    }
    this.save();
    return true;
  }

  list(opts: { inLibraryOnly?: boolean; source?: AssetSource } = {}): AssetRecord[] {
    const onlyLib = opts.inLibraryOnly !== false;
    return [...this.records.values()]
      .filter(
        (r) =>
          (!onlyLib || r.inLibrary) &&
          (!opts.source || r.refs.some((x) => x.source === opts.source)),
      )
      .sort((a, b) => (b.addedAt ?? b.createdAt) - (a.addedAt ?? a.createdAt));
  }

  read(id: string): { data: Buffer; mime: string } | null {
    const rec = this.records.get(id);
    if (!rec) return null;
    try {
      return { data: fs.readFileSync(this.filePath(rec)), mime: rec.mime };
    } catch {
      return null;
    }
  }
}
