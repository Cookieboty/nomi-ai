/**
 * Codex 会话索引读取 worker（worker_threads）：在这里同步执行 readCodexThreads（node:sqlite 只读打开），
 * 只把行（普通对象）发回主线程。协议见 codexThreadReader.ts 的 CodexIndexRequest / CodexIndexReply。
 */
import { parentPort } from 'node:worker_threads';

import { readCodexThreads } from './codexThreadIndex';
import type { CodexIndexReply, CodexIndexRequest } from './codexThreadReader';

const port = parentPort;
if (port) {
  port.on('message', (m: CodexIndexRequest) => {
    let reply: CodexIndexReply;
    try {
      // node:sqlite 返回的行原型为 null：展开成普通对象再结构化克隆
      reply = { id: m.id, ok: true, rows: readCodexThreads(m.file).map((r) => ({ ...r })) };
    } catch (e) {
      reply = { id: m.id, ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    port.postMessage(reply);
  });
}
