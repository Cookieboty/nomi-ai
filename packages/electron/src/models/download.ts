import { createHash } from 'node:crypto';
import { createReadStream, promises as fsp } from 'node:fs';

import { t } from '../i18n';

import { isAllowedUrl, type CatalogFile, type UrlPolicy } from './catalog';

export interface DownloadProgress {
  received: number;
  total: number;
}

export interface DownloadOptions {
  fetchImpl?: typeof fetch;
  policy?: UrlPolicy;
  signal?: AbortSignal;
  onProgress?: (p: DownloadProgress) => void;
  /** 每个 URL 的尝试次数（默认 2），失败后换下一个 URL */
  attemptsPerUrl?: number;
  /**
   * 空闲超时（毫秒）：连接 / 收到响应头 / 读到数据后，超过这么久没有新数据就中止本次尝试
   * （按失败处理，可重试 / 换镜像）。不设置则只受 signal 控制。
   */
  idleTimeoutMs?: number;
}

export class DownloadError extends Error {}

export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await fsp.stat(path)).size;
  } catch {
    return 0;
  }
}

/**
 * 下载到 dest：先写 dest.part（支持 Range 续传），完成后校验大小 + sha256 再原子改名。
 * 仅允许 https（测试可放行回环 http）；超过声明大小立即中止；任何校验失败都删除临时文件。
 */
export async function downloadVerified(
  file: CatalogFile,
  dest: string,
  opts: DownloadOptions = {},
): Promise<void> {
  const doFetch = opts.fetchImpl ?? fetch;
  const part = `${dest}.part`;
  const attempts = opts.attemptsPerUrl ?? 2;
  let lastError: unknown = null;

  for (const url of file.urls) {
    if (!isAllowedUrl(url, opts.policy)) continue;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (opts.signal?.aborted) throw new DownloadError(t('已取消'));
      // 每次尝试一个独立的 controller：用户取消和空闲超时都能中止 fetch / read
      const ctl = new AbortController();
      const attemptSignal = ctl.signal;
      const onUserAbort = () => ctl.abort();
      opts.signal?.addEventListener('abort', onUserAbort, { once: true });
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        if (!opts.idleTimeoutMs) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => ctl.abort(), opts.idleTimeoutMs);
      };
      try {
        arm();
        let have = await sizeOf(part);
        if (have > file.size) {
          await fsp.rm(part, { force: true });
          have = 0;
        }
        if (have < file.size) {
          const res = await doFetch(url, {
            headers: have > 0 ? { Range: `bytes=${have}-` } : {},
            redirect: 'follow',
            signal: attemptSignal,
          });
          arm();
          // 重定向后仍需 https
          if (res.url && !isAllowedUrl(res.url, opts.policy))
            throw new DownloadError(t('重定向到不安全地址: {0}', res.url));
          if (res.status === 200 && have > 0) {
            have = 0; // 服务端不支持 Range：从头开始
            await fsp.rm(part, { force: true });
          } else if (res.status !== 200 && res.status !== 206) {
            throw new DownloadError(`HTTP ${res.status}`);
          }
          if (!res.body) throw new DownloadError(t('空响应'));
          const fh = await fsp.open(part, have > 0 ? 'a' : 'w');
          try {
            const reader = res.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              arm();
              have += value.byteLength;
              if (have > file.size) {
                await reader.cancel();
                throw new DownloadError(t('文件大小超过目录声明，已中止'));
              }
              await fh.write(value);
              opts.onProgress?.({ received: have, total: file.size });
            }
          } finally {
            if (idleTimer) clearTimeout(idleTimer); // 网络阶段结束；校验哈希不受空闲超时影响
            await fh.close();
          }
        }
        if ((await sizeOf(part)) !== file.size) throw new DownloadError(t('文件不完整'));
        const digest = await sha256File(part);
        if (digest !== file.sha256) {
          await fsp.rm(part, { force: true });
          throw new DownloadError(t('sha256 校验失败，已丢弃文件'));
        }
        await fsp.rename(part, dest);
        return;
      } catch (err) {
        lastError = err;
        if (opts.signal?.aborted) {
          throw new DownloadError(t('已取消'));
        }
        if (attemptSignal.aborted) lastError = new DownloadError(t('下载长时间没有数据，已中止'));
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
        opts.signal?.removeEventListener('abort', onUserAbort);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new DownloadError(t('没有可用的下载地址'));
}
