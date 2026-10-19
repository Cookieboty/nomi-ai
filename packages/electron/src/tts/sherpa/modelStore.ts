/**
 * sherpa 模型目录：定位（env / extraResources / 开发态 / userData）、校验大小、
 * 缺失时下载安装（开发启动与 sync 脚本共用；打包产物已有模型则不会走到这里）。
 */
import fs from 'node:fs';
import path from 'node:path';

import { t } from '../../i18n';
import { downloadVerified, renameWithRetry, type DownloadProgress } from '../../voice/download';

import { extractTarBz2 } from './bz2Extract';
import { SHERPA_MANIFEST, type ModelManifest } from './manifest';

export type ModelSource = 'env' | 'resources' | 'dev' | 'userData';

export interface VerifyResult {
  ok: boolean;
  /** 缺失或大小不符的相对路径 */
  bad: string[];
}

export function verifyModelDir(
  dir: string,
  manifest: ModelManifest = SHERPA_MANIFEST,
): VerifyResult {
  const bad: string[] = [];
  for (const [rel, bytes] of Object.entries(manifest.files)) {
    try {
      if (fs.statSync(path.join(dir, rel)).size !== bytes) bad.push(rel);
    } catch {
      bad.push(rel);
    }
  }
  return { ok: bad.length === 0, bad };
}

export interface LocateOptions {
  /** 例如 process.env.NOMI_SHERPA_TTS_MODEL_DIR */
  envDir?: string;
  /** 打包后：process.resourcesPath/tts-models/<id> */
  resourcesDir?: string;
  /** 开发态（未打包）候选目录 */
  devDirs?: string[];
  /** userData/tts-models（运行时自动下载落点之一） */
  userRoot?: string;
  manifest?: ModelManifest;
}

export function locateModel(opts: LocateOptions): { dir: string; source: ModelSource } | null {
  const manifest = opts.manifest ?? SHERPA_MANIFEST;
  const candidates: Array<{ dir: string; source: ModelSource }> = [];
  if (opts.envDir) candidates.push({ dir: opts.envDir, source: 'env' });
  if (opts.resourcesDir) candidates.push({ dir: opts.resourcesDir, source: 'resources' });
  for (const d of opts.devDirs ?? []) candidates.push({ dir: d, source: 'dev' });
  if (opts.userRoot)
    candidates.push({ dir: path.join(opts.userRoot, manifest.id), source: 'userData' });
  for (const c of candidates) {
    if (verifyModelDir(c.dir, manifest).ok) return c;
  }
  return null;
}

export type InstallPhase = 'download' | 'extract';

/** 安装失败的阶段，便于日志 / 文档对号入座 */
export type InstallFailPhase = 'prepare' | 'download' | 'extract' | 'verify' | 'finalize';

export class SherpaInstallError extends Error {
  constructor(
    readonly phase: InstallFailPhase,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SherpaInstallError';
  }
}

const errText = (e: unknown): string => {
  if (!(e instanceof Error)) return String(e);
  const code = (e as NodeJS.ErrnoException).code;
  return code && !e.message.includes(code) ? `${code}: ${e.message}` : e.message;
};

/** Windows 常见：盘符不存在 / 无写权限 / 只读 → 提前探测，给出明确错误（而不是下载 120MB 后才失败） */
export function probeWritableDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.nomi-write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
  } catch (e) {
    throw new SherpaInstallError(
      'prepare',
      `model dir not writable: ${dir} (${errText(e)}) — 请检查盘符是否存在 / 目录权限，` +
        `或用 NOMI_SHERPA_TTS_MODEL_DIR 指向已手动解压的模型目录`,
      e,
    );
  }
}

export interface InstallOptions {
  /**
   * 安装根目录：最终模型在 `<installRoot>/<id>/`。
   * 开发态优先仓库同级 `../models`；打包态回退 `userData/tts-models`。
   */
  installRoot: string;
  manifest?: ModelManifest;
  /** 下载地址（镜像优先）；默认只用 manifest.url */
  urls?: string[];
  /** 每个地址的最大尝试次数（默认 3） */
  attempts?: number;
  /** 空闲超时：连接 / 数据块间隔（默认 30s） */
  idleTimeoutMs?: number;
  /** 重试退避基数（默认 1500ms，线性递增） */
  retryDelayMs?: number;
  signal?: AbortSignal;
  /** 断点续传：失败 / 进程退出后保留 `.download/<id>.tar.bz2.part`，下次 Range 续传 */
  resume?: boolean;
  onProgress?: (phase: InstallPhase, p: DownloadProgress) => void;
  /** 重试 / 切换镜像等事件日志 */
  onEvent?: (msg: string, extra?: Record<string, unknown>) => void;
  /** 测试注入 */
  download?: typeof downloadVerified;
  extract?: typeof extractTarBz2;
  fetchImpl?: Parameters<typeof downloadVerified>[0]['fetchImpl'];
  sleep?: (ms: number) => Promise<void>;
}

const rmQuiet = (p: string, recursive = false): void => {
  try {
    // Windows：杀软 / 索引服务可能暂时占用，带重试
    fs.rmSync(p, { recursive, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* 清理失败不影响主流程（下次启动会再清） */
  }
};

/**
 * 下载（sha256 校验，多镜像 × 重试 × 空闲超时）→ 解压到 `<id>.partial` → 逐文件校验大小 →
 * 原子改名（Windows 带重试）为 `<id>`。
 * 任一步失败都清理临时文件并抛 SherpaInstallError（带阶段；调用方保持静默）。
 */
export async function installModel(opts: InstallOptions): Promise<string> {
  const manifest = opts.manifest ?? SHERPA_MANIFEST;
  const download = opts.download ?? downloadVerified;
  const extract = opts.extract ?? extractTarBz2;
  const urls = opts.urls?.length ? opts.urls : [manifest.url];
  const attempts = Math.max(1, opts.attempts ?? 3);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const finalDir = path.join(opts.installRoot, manifest.id);
  const partialDir = `${finalDir}.partial`;
  const archive = path.join(opts.installRoot, '.download', `${manifest.id}.tar.bz2`);

  probeWritableDir(opts.installRoot);
  rmQuiet(partialDir, true);
  try {
    const failures: string[] = [];
    let downloaded = false;
    outer: for (const url of urls) {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          opts.onEvent?.(`download start (${attempt}/${attempts})`, { url });
          await download({
            url,
            sha256: manifest.sha256,
            dest: archive,
            expectedBytes: manifest.bytes,
            signal: opts.signal,
            idleTimeoutMs: opts.idleTimeoutMs ?? 30_000,
            onProgress: (p) => opts.onProgress?.('download', p),
            fetchImpl: opts.fetchImpl,
            resume: opts.resume,
          });
          downloaded = true;
          break outer;
        } catch (e) {
          if (opts.signal?.aborted) throw e;
          const msg = errText(e);
          failures.push(`${url} #${attempt}: ${msg}`);
          opts.onEvent?.(`download failed (${attempt}/${attempts}): ${msg}`, { url });
          const status = (e as { status?: number }).status;
          // 4xx（地址失效 / 无权限）重试没意义，直接换下一个地址
          if (status && status >= 400 && status < 500) break;
          if (attempt < attempts) await sleep((opts.retryDelayMs ?? 1500) * attempt);
        }
      }
    }
    if (!downloaded) {
      throw new SherpaInstallError(
        'download',
        `model download failed after trying ${urls.length} url(s): ${failures.slice(-3).join(' | ')}` +
          ` — 网络慢 / GitHub 不可达时请设置 NOMI_SHERPA_TTS_MODEL_URL 镜像，或手动下载解压（见 docs/features/voice.md）`,
      );
    }
    opts.onProgress?.('extract', { received: 0, total: 1 });
    try {
      await extract(archive, partialDir, { stripTop: manifest.topDir, signal: opts.signal });
    } catch (e) {
      throw new SherpaInstallError(
        'extract',
        `model extract failed (${partialDir}): ${errText(e)} — 可能磁盘空间不足 / 目录被占用 / 归档损坏`,
        e,
      );
    }
    const v = verifyModelDir(partialDir, manifest);
    if (!v.ok) {
      throw new SherpaInstallError(
        'verify',
        t('模型文件校验失败：{0}', v.bad.slice(0, 3).join(', ')),
      );
    }
    try {
      rmQuiet(finalDir, true);
      await renameWithRetry(partialDir, finalDir);
    } catch (e) {
      throw new SherpaInstallError(
        'finalize',
        `model finalize failed (${partialDir} → ${finalDir}): ${errText(e)} — 目录可能被杀毒软件 / 资源管理器占用`,
        e,
      );
    }
    opts.onProgress?.('extract', { received: 1, total: 1 });
    return finalDir;
  } catch (e) {
    rmQuiet(partialDir, true);
    throw e;
  } finally {
    rmQuiet(archive);
  }
}

/** 下载临时目录（`.download/`，含续传用的 `.part`） */
export function downloadTmpDir(installRoot: string): string {
  return path.join(installRoot, '.download');
}

/** 删除已安装模型 + 半成品 + 下载临时文件（「删除模型」/ 取消下载用） */
export function removeModel(
  installRoot: string,
  manifest: ModelManifest = SHERPA_MANIFEST,
  opts: { keepModel?: boolean } = {},
): void {
  const finalDir = path.join(installRoot, manifest.id);
  if (!opts.keepModel) rmQuiet(finalDir, true);
  rmQuiet(`${finalDir}.partial`, true);
  rmQuiet(downloadTmpDir(installRoot), true);
}

/** 已下载的续传字节数（UI 显示「将从 x% 继续」用；没有返回 0） */
export function partialDownloadBytes(
  installRoot: string,
  manifest: ModelManifest = SHERPA_MANIFEST,
): number {
  try {
    return fs.statSync(path.join(downloadTmpDir(installRoot), `${manifest.id}.tar.bz2.part`)).size;
  } catch {
    return 0;
  }
}
