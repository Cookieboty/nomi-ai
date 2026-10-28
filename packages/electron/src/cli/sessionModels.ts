/**
 * 会话 → 上一次成功跑完一轮时用的第三方模型（`供应商/模型`）。
 * CLI 自己的历史文件里只有上游的裸模型名，看不出走的是哪个供应商；打开历史会话时据此回到原供应商，
 * 而不是落到「模型」页当前给这个编程助手分配的默认模型上。
 * 存在 userData/harness/session-models.json（0600），最多 MAX_SESSIONS 条，旧的先淘汰。
 */
import fs from 'node:fs';
import path from 'node:path';

import { writePrivateFileAtomicAsync } from '../utils/privateFile';

const FILE = 'session-models.json';
export const MAX_SESSIONS = 5000;

export class SessionModelTable {
  private map: Map<string, string> | null = null;

  constructor(
    private readonly root: string,
    private readonly warn: (msg: string, err: unknown) => void = () => {},
  ) {}

  private load(): Map<string, string> {
    if (this.map) return this.map;
    const m = new Map<string, string>();
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.root, FILE), 'utf8')) as {
        sessions?: unknown;
      };
      if (Array.isArray(raw.sessions))
        for (const e of raw.sessions)
          if (Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string')
            m.set(e[0], e[1]);
    } catch {
      /* 第一次 */
    }
    this.map = m;
    return m;
  }

  get(backend: string, sessionId: string): string | undefined {
    return this.load().get(`${backend}:${sessionId}`);
  }

  /** 记下这个会话这一轮用的模型；没变就不写 */
  note(backend: string, sessionId: string, ref: string): void {
    const sid = sessionId.trim();
    if (!sid || !ref) return;
    const m = this.load();
    const key = `${backend}:${sid}`;
    if (m.get(key) === ref) return;
    // 重新插入：最近用过的排在最后，淘汰时先删最久没用的
    m.delete(key);
    m.set(key, ref);
    while (m.size > MAX_SESSIONS) m.delete(m.keys().next().value!);
    void writePrivateFileAtomicAsync(
      path.join(this.root, FILE),
      JSON.stringify({ version: 1, sessions: [...m] }),
    ).catch((e) => this.warn('session-models write failed', e));
  }
}
