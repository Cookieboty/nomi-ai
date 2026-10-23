/**
 * 从 Claude Code 自己的会话记录（~/.claude/projects/<cwd>/<sessionId>.jsonl）读当前上下文占用。
 * 每条主线程 assistant 就是一次模型请求，带真实 usage 与模型名；压缩边界带压缩后的大小。
 * Nomi 自己落盘的消息只有「轮末」用量：一轮里自动压缩后被中断 / 重启、或在终端里直接用过 CLI 时，
 * 只有这里是准的。分项（用户 / 助手 / 工具 / 思考）按最后一次压缩之后的内容估算——
 * Nomi 的消息里可能缺这段（压缩后的一轮没落盘），否则差值会被全算成「系统提示」。
 * 只读文件尾部（上限 TAIL_BYTES），按文件大小 + 修改时间缓存。
 */
import fs from 'node:fs';
import path from 'node:path';

interface TranscriptCategories {
  user: number;
  assistant: number;
  tools: number;
  thinking: number;
}

export interface TranscriptContext {
  contextTokens: number;
  model?: string;
  /** 最近一条是压缩边界（还没有压缩后的请求） */
  compacted?: boolean;
  /**
   * 分项：system = 压缩后（或会话开始后）第一次请求的真实占用 − 它之前的内容 ≈ 系统提示 / 工具定义 / 记忆；
   * 其余各类按内容估算的比例分摊「总量 − system」，加起来等于总量。
   */
  breakdown?: TranscriptCategories & { system: number };
}

/** 尾部读取上限：压缩后到 1M 窗口的对话约 4MB 文本，8MB 足够；超出时分项只按读到的部分算 */
const TAIL_BYTES = 8 * 1024 * 1024;

const CJK = /[\u2e80-\u9fff\uac00-\ud7af\uff00-\uffef\u3040-\u30ff]/;
/** 与渲染端 slash/tokens.ts 的 estimateTokens 同一口径：CJK 约 1 token / 字，其它约 4 字符 1 token */
function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk + other / 4);
}

const blockText = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (Array.isArray(v))
    return v
      .map((b) =>
        b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string'
          ? (b as { text: string }).text
          : '',
      )
      .join('\n');
  return '';
};

/** 一行会话记录按类型拆分的估算 token */
function lineCategories(j: Record<string, unknown>, into: TranscriptCategories): void {
  const msg = (j.message ?? {}) as { content?: unknown };
  const content = msg.content;
  if (j.type === 'user') {
    if (typeof content === 'string') into.user += estimateTokens(content);
    else if (Array.isArray(content))
      for (const b of content as Array<Record<string, unknown>>) {
        if (b?.type === 'tool_result') into.tools += estimateTokens(blockText(b.content));
        else if (b?.type === 'text') into.user += estimateTokens(String(b.text ?? ''));
      }
  } else if (j.type === 'assistant' && Array.isArray(content)) {
    for (const b of content as Array<Record<string, unknown>>) {
      if (b?.type === 'text') into.assistant += estimateTokens(String(b.text ?? ''));
      else if (b?.type === 'thinking') into.thinking += estimateTokens(String(b.thinking ?? ''));
      else if (b?.type === 'tool_use')
        into.tools += estimateTokens(`${String(b.name ?? '')} ${JSON.stringify(b.input ?? '')}`);
    }
  }
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;

/** Claude Code 的项目目录名：工作目录里非字母数字的字符都换成 '-' */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

async function readTail(file: string, bytes = TAIL_BYTES): Promise<string | null> {
  let fh: fs.promises.FileHandle | undefined;
  try {
    fh = await fs.promises.open(file, 'r');
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    // 从中间开始读时第一行不完整，丢掉
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

const requestContext = (u: Record<string, unknown> | undefined): number | undefined => {
  if (!u) return undefined;
  const parts = [
    u.input_tokens,
    u.cache_read_input_tokens,
    u.cache_creation_input_tokens,
    u.output_tokens,
  ].map(num);
  if (parts.every((x) => x === undefined)) return undefined;
  return parts.reduce<number>((s, x) => s + (x ?? 0), 0) || undefined;
};

const sumCats = (c: TranscriptCategories) => c.user + c.assistant + c.tools + c.thinking;

/**
 * 只看最后一次压缩之后（没压缩过则为读到的全部）：总量取最近一次主线程请求（或压缩后大小），
 * 分项见 TranscriptContext.breakdown（纯函数，便于单测）
 */
export function lastTranscriptContext(text: string): TranscriptContext | null {
  const lines = text.split('\n');
  // 先正向切出最后一次压缩之后的片段
  let from = 0;
  let boundaryPost: number | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"compact_boundary"')) continue;
    try {
      const j = JSON.parse(line) as Record<string, unknown>;
      if (j.type !== 'system' || j.subtype !== 'compact_boundary') continue;
      const meta = (j.compactMetadata ?? j.compact_metadata ?? {}) as Record<string, unknown>;
      boundaryPost = num(meta.postTokens) ?? num(meta.post_tokens);
      from = i + 1;
      break;
    } catch {
      /* 不完整的行 */
    }
  }
  const cats: TranscriptCategories = { user: 0, assistant: 0, tools: 0, thinking: 0 };
  let last: { ctx: number; model?: string } | undefined;
  /** 片段里第一次主线程请求的占用，以及它之前的内容估算（用来算系统提示基线） */
  let first: { ctx: number; before: number; output: number } | undefined;
  for (let i = from; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line.startsWith('{')) continue;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (j.isSidechain === true) continue;
    if (j.type === 'assistant' && j.isApiErrorMessage !== true) {
      const msg = (j.message ?? {}) as { usage?: Record<string, unknown>; model?: unknown };
      const ctx = requestContext(msg.usage);
      if (ctx) {
        first ??= { ctx, before: sumCats(cats), output: num(msg.usage?.output_tokens) ?? 0 };
        // <synthetic> 是 CLI 自己补的占位消息，不是模型名
        const model =
          typeof msg.model === 'string' && !msg.model.startsWith('<') ? msg.model : undefined;
        last = { ctx, model: model ?? last?.model };
      }
    }
    lineCategories(j, cats);
  }
  const total = last?.ctx ?? boundaryPost;
  if (!total) return null;
  const est = sumCats(cats);
  // 系统提示基线：第一次请求的输入里除了它之前的对话内容，剩下的就是系统提示 / 工具定义 / 记忆
  const system = Math.max(
    0,
    Math.min(total, first ? first.ctx - first.output - first.before : total - est),
  );
  const k = est > 0 ? Math.max(0, total - system) / est : 0;
  const breakdown = {
    system: Math.round(system),
    user: Math.round(cats.user * k),
    assistant: Math.round(cats.assistant * k),
    tools: Math.round(cats.tools * k),
    thinking: Math.round(cats.thinking * k),
  };
  return {
    contextTokens: total,
    ...(last?.model ? { model: last.model } : {}),
    ...(last ? {} : { compacted: true }),
    breakdown,
  };
}

/** 定位会话记录：先按工作目录算目录名，找不到再在 projects/ 下按文件名找（目录名规则以后可能变） */
async function findTranscript(
  configDir: string,
  cwd: string,
  sessionId: string,
): Promise<string | null> {
  const root = path.join(configDir, 'projects');
  const name = `${sessionId}.jsonl`;
  const direct = path.join(root, claudeProjectDirName(cwd), name);
  if (fs.existsSync(direct)) return direct;
  try {
    for (const d of await fs.promises.readdir(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const p = path.join(root, d.name, name);
      if (fs.existsSync(p)) return p;
    }
  } catch {
    /* 没有 projects 目录 */
  }
  return null;
}

/** 文件没变（大小 + 修改时间）就不重读：切标签 / 刷新时反复调用很便宜 */
const cache = new Map<string, { key: string; value: TranscriptContext | null }>();

export async function claudeTranscriptContext(
  configDir: string,
  cwd: string,
  sessionId: string,
): Promise<TranscriptContext | null> {
  if (!/^[0-9a-f-]{8,64}$/i.test(sessionId)) return null;
  const file = await findTranscript(configDir, cwd, sessionId);
  if (!file) return null;
  const st = await fs.promises.stat(file).catch(() => null);
  if (!st) return null;
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = cache.get(file);
  if (hit?.key === key) return hit.value;
  const tail = await readTail(file);
  const value = tail ? lastTranscriptContext(tail) : null;
  if (cache.size > 32) cache.clear();
  cache.set(file, { key, value });
  return value;
}
