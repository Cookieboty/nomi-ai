import { z } from 'zod';

import type { ToolDefinition } from '../../../types/common';

export interface HttpGetReadonlyConfig {
  /** 白名单主机名（精确匹配 hostname；空数组表示全部拒绝） */
  allowHosts: string[];
  /** 响应最大字节；默认 1 MiB */
  maxContentLength?: number;
  fetchImpl?: typeof fetch;
}

export const httpGetReadonlyInputSchema = z
  .object({
    url: z.string().url(),
    headers: z.record(z.string(), z.string().max(1024)).optional(),
    timeoutMs: z.number().int().positive().max(30_000).optional(),
  })
  .strict();

export type HttpGetReadonlyInput = z.infer<typeof httpGetReadonlyInputSchema>;

export interface HttpGetReadonlyOutput {
  status: number;
  contentType: string | null;
  body: string;
  truncated: boolean;
}

export function createHttpGetReadonlyTool(
  cfg: HttpGetReadonlyConfig,
): ToolDefinition<HttpGetReadonlyInput, HttpGetReadonlyOutput> {
  const maxLen = cfg.maxContentLength ?? 1024 * 1024;
  const fetchImpl = cfg.fetchImpl ?? fetch;

  return {
    name: 'http_get_readonly',
    description: '对指定 URL 发起 GET 请求；仅支持白名单主机，响应体大小受限；不支持任何写方法。',
    input: httpGetReadonlyInputSchema,
    async execute(input, execCtx) {
      const { url, headers, timeoutMs } = httpGetReadonlyInputSchema.parse(input);
      const u = new URL(url);
      if (!cfg.allowHosts.includes(u.hostname)) {
        throw new Error(`host not allowed: ${u.hostname}`);
      }

      const ac = new AbortController();
      const timer = timeoutMs
        ? setTimeout(() => ac.abort(new Error('timeout')), timeoutMs)
        : undefined;
      execCtx.signal?.addEventListener('abort', () => ac.abort(execCtx.signal?.reason));

      try {
        const res = await fetchImpl(url, {
          method: 'GET',
          headers,
          signal: ac.signal,
        });

        // 提前拒绝过大的响应
        const cl = res.headers.get('content-length');
        if (cl && Number(cl) > maxLen) {
          throw new Error(`content too large: ${cl} bytes`);
        }

        const buf = await res.arrayBuffer();
        const truncated = buf.byteLength > maxLen;
        const view = new Uint8Array(buf, 0, Math.min(buf.byteLength, maxLen));
        const body = new TextDecoder('utf-8', { fatal: false }).decode(view);
        return {
          status: res.status,
          contentType: res.headers.get('content-type'),
          body,
          truncated,
        };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
