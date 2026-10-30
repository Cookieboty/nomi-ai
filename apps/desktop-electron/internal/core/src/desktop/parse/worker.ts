/**
 * 文档解析子进程（Electron utilityProcess）：与主进程隔离、限制内存（--max-old-space-size）并由父进程超时杀死，
 * 恶意 / 超大的 PDF、DOCX 无法拖垮主进程。只接收一个已通过路径守卫的绝对路径，只读，不联网。
 */
import * as fs from 'fs';

import { extract } from './extract';

interface Req {
  path: string;
  maxBytes: number;
}

type Port = {
  on(ev: 'message', fn: (e: { data: Req }) => void): void;
  postMessage(m: unknown): void;
};
const port = (process as unknown as { parentPort?: Port }).parentPort;

port?.on('message', async (e) => {
  const { path: p, maxBytes } = e.data;
  try {
    const st = await fs.promises.stat(p);
    if (!st.isFile()) throw Object.assign(new Error('不是文件'), { code: 'not_file' });
    if (st.size > maxBytes)
      throw Object.assign(new Error(`文件过大（${st.size} 字节）`), { code: 'too_large' });
    const buf = await fs.promises.readFile(p);
    const r = await extract(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), p);
    port.postMessage({ ok: true, ...r });
  } catch (err) {
    port.postMessage({
      ok: false,
      code: (err as { code?: string }).code ?? 'parse_failed',
      message: err instanceof Error ? err.message : String(err),
    });
  }
});
