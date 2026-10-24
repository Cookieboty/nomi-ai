/** Gemini CLI 会话文件的折叠（历史转录与进度监视共用；从主进程 agents/parsers.ts 搬来） */
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

export interface GeminiChat {
  sessionId?: string;
  startTime?: string;
  lastUpdated?: string;
  /** 'main' | 'subagent'（0.62 起写在头部；旧文件没有） */
  kind?: string;
  summary?: string;
  messages: Array<Record<string, unknown>>;
}

/**
 * Gemini CLI 会话文件 → 头部 + 消息列表。兼容两种格式：
 * - 旧版 `session-*.json`：一整份 `{ sessionId, messages: [...] }`
 * - 0.62 起 `session-*.jsonl`：首行头部，之后每行一条消息（同一 id 会被重写多次，后写的为准），
 *   `{ $set: {...} }` 行更新头部字段
 * 截断的 / 正在写入的半行直接跳过。
 */
export function foldGeminiChat(raw: string): GeminiChat {
  const trimmed = raw.trimStart();
  if (trimmed.startsWith('{') && !trimmed.includes('\n{')) {
    try {
      const j = JSON.parse(trimmed) as Record<string, unknown>;
      if (Array.isArray(j.messages)) {
        return {
          sessionId: str(j.sessionId),
          startTime: str(j.startTime),
          lastUpdated: str(j.lastUpdated),
          kind: str(j.kind),
          summary: str(j.summary),
          messages: j.messages as Array<Record<string, unknown>>,
        };
      }
    } catch {
      /* 不是整份 JSON：按 JSONL 继续 */
    }
  }
  const head: Record<string, unknown> = {};
  const order: string[] = [];
  const byId = new Map<string, Record<string, unknown>>();
  let n = 0;
  for (const line of raw.split('\n')) {
    const l = line.trim();
    if (!l.startsWith('{')) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(l) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (o.$set && typeof o.$set === 'object') {
      Object.assign(head, o.$set);
      continue;
    }
    if (typeof o.type === 'string' && ('content' in o || 'toolCalls' in o)) {
      const id = str(o.id) ?? `#${n++}`;
      if (!byId.has(id)) order.push(id);
      byId.set(id, o);
      continue;
    }
    if (str(o.sessionId)) Object.assign(head, o);
  }
  return {
    sessionId: str(head.sessionId),
    startTime: str(head.startTime),
    lastUpdated: str(head.lastUpdated),
    kind: str(head.kind),
    summary: str(head.summary),
    messages: order.map((id) => byId.get(id)!),
  };
}

/** Gemini 消息内容：字符串，或 `[{ text }]` 分段（没有 type 字段） */
export function geminiText(content: unknown): string | undefined {
  if (typeof content === 'string') return content || undefined;
  if (Array.isArray(content)) {
    const parts = content
      .map((c) => (c && typeof c === 'object' ? str((c as Record<string, unknown>).text) : str(c)))
      .filter((x): x is string => Boolean(x));
    return parts.length ? parts.join('\n') : undefined;
  }
  return undefined;
}
