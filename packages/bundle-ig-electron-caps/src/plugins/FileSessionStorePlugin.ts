import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  ProfileStorageKey,
  definePlugin,
  type IProfileStorage,
  type PluginContext,
  type UserProfile,
} from '@nomi-ai/bundle-ig-base';

export interface FileSessionStoreConfig {
  /** 根目录（宿主给 userData）；不给时不提供会话 / 用户画像存储 */
  rootDir?: string;
  /** userData 之下的子目录，默认 'ai-chat' */
  subDir?: string;
  /** 单个 session JSONL 文件的轮转阈值（字节），默认 100 MiB */
  rotateBytes?: number;
}

/** 单条 JSONL 记录：不强约束 payload；由上层协议约定 */
export interface SessionRecord {
  ts?: number;
  [k: string]: unknown;
}

export interface SessionStore {
  append(sessionId: string, record: SessionRecord): Promise<void>;
  read(sessionId: string): Promise<SessionRecord[]>;
  list(): Promise<string[]>;
}

export class FileSessionStore implements SessionStore {
  constructor(
    private readonly baseDir: string,
    private readonly rotateBytes: number,
    private readonly logger: PluginContext['logger'],
  ) {}

  private async ensureBase(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
  }

  private currentFile(sessionId: string): string {
    return join(this.baseDir, `${sessionId}.jsonl`);
  }

  private async rotateIfNeeded(file: string): Promise<void> {
    if (!existsSync(file)) return;
    const s = await stat(file);
    if (s.size < this.rotateBytes) return;
    const rotated = `${file}.${Date.now()}.rot`;
    await rename(file, rotated);
    this.logger.info(`session file rotated: ${file} -> ${rotated}`);
  }

  async append(sessionId: string, record: SessionRecord): Promise<void> {
    await this.ensureBase();
    const file = this.currentFile(sessionId);
    await this.rotateIfNeeded(file);
    const line = `${JSON.stringify({ ts: Date.now(), ...record })}\n`;
    await appendFile(file, line, 'utf8');
  }

  async read(sessionId: string): Promise<SessionRecord[]> {
    const file = this.currentFile(sessionId);
    if (!existsSync(file)) return [];
    const txt = await readFile(file, 'utf8');
    const out: SessionRecord[] = [];
    for (const line of txt.split('\n')) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as SessionRecord);
      } catch (err) {
        this.logger.warn(`skip broken jsonl line in ${sessionId}`, err);
      }
    }
    return out;
  }

  async list(): Promise<string[]> {
    if (!existsSync(this.baseDir)) return [];
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(this.baseDir);
    return files
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.slice(0, -'.jsonl'.length))
      .sort();
  }
}

export class FileProfileStorage implements IProfileStorage {
  constructor(
    private readonly file: string,
    private readonly logger: PluginContext['logger'],
  ) {}

  async read(): Promise<UserProfile | undefined> {
    try {
      const txt = await readFile(this.file, 'utf8');
      return JSON.parse(txt) as UserProfile;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return undefined;
      this.logger.warn('profile storage: read failed', err);
      return undefined;
    }
  }

  async write(profile: UserProfile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, JSON.stringify(profile, null, 2), 'utf8');
    await rename(tmp, this.file);
  }

  async clear(): Promise<void> {
    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(this.file);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw err;
    }
  }
}

function resolveRoot(rootDir: string, cfg: FileSessionStoreConfig): string {
  return join(rootDir, cfg.subDir ?? 'ai-chat');
}

export const FileSessionStorePlugin = definePlugin<FileSessionStoreConfig>({
  name: 'FileSessionStorePlugin',
  apply(ctx: PluginContext, cfg: FileSessionStoreConfig) {
    if (!cfg.rootDir) {
      ctx.logger.warn('FileSessionStorePlugin skipped: no rootDir given by the host');
      return;
    }
    const base = resolveRoot(cfg.rootDir, cfg);

    const rotate = cfg.rotateBytes ?? 100 * 1024 * 1024;
    const sessionDir = join(base, 'sessions');
    const sessionStore = new FileSessionStore(sessionDir, rotate, ctx.logger);
    void sessionStore; // TODO: 接入 ctx.sessions 后挂接会话存储

    const profileFile = join(base, 'memory', 'user_profile.json');
    ctx.provide(ProfileStorageKey, new FileProfileStorage(profileFile, ctx.logger));

    ctx.logger.info(
      `FileSessionStore ready: sessions=${sessionDir}, profile=${profileFile}, rotateBytes=${rotate}`,
    );
  },
});
