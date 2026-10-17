/**
 * 解析各编程助手本地会话文件，推断会话身份（id / cwd / 标题）与最后状态。
 * 仅读本地文件，不访问任何远端账号。格式依据各工具当前（2026）的本地存储：
 *
 * - Claude Code  ~/.claude/projects/<编码后的 cwd>/<sessionId>.jsonl
 *   行：{ type: 'user'|'assistant'|'system'|'summary'|'progress', sessionId, cwd, timestamp,
 *        isSidechain?, message: { role, content, stop_reason? } }
 *   子代理写在 <sessionId>/subagents/*.jsonl（或 isSidechain=true）——并入父会话，不单列。
 *   交互会话没有 "result" 行：assistant.stop_reason === 'end_turn' 表示这一轮结束、在等用户。
 * - Codex CLI    ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 *   新格式：{ timestamp, type: 'session_meta'|'event_msg'|'response_item'|'turn_context', payload }
 *   event_msg.payload.type: task_started / task_complete / user_message / agent_message / error …
 *   旧格式 / `codex exec --json`：{ type: 'turn.started'|'turn.completed'|'turn.failed' … }
 * - Gemini CLI   ~/.gemini/tmp/<projectHash>/chats/session-*.json（整份 JSON，messages[]）
 * - Aider        <repo>/.aider.chat.history.md、~/.aider/analytics.jsonl
 * - Cline        ~/.cline/**（job.json / NDJSON，CLI 模式）
 * - Continue     ~/.continue/sessions/<id>.json
 * - Grok Build   ~/.grok/sessions/<cwd>/<uuid>/updates.jsonl（mtime；内容解析见用量模块）
 * - Cursor       cursor-agent CLI：~/.cursor/chats/<hash>/<id>/（SQLite store.db，无公开格式）
 *                ——只用 mtime + 进程存活判断，不解析内容。
 */
export type AgentKind =
  'codex' | 'claude' | 'dsh' | 'grok' | 'aider' | 'cline' | 'continue' | 'cursor' | 'gemini';

/**
 * running   正在干活（模型在输出或工具在跑）
 * waiting   这一轮做完了，在等你回复（进程仍在）
 * completed 明确结束（任务完成 / 进程已退出且最后一轮已完成）
 * failed    出错
 * stalled   进程还在、上一步是工具在跑，却已经很久没有写入
 * idle      没有足够信息（进程已退出且未完成 / 未知）
 */
export type AgentStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'stalled' | 'idle';

/** 最后一个事件的语义（与时间、进程无关），由 service 结合 mtime / 进程算出最终状态 */
export type LastPhase = 'working' | 'tool' | 'turn-done' | 'task-done' | 'error' | 'unknown';

export interface SessionInfo {
  /** 工具内的会话 id（用于去重）；没有时为 undefined，由文件路径兜底 */
  sessionId?: string;
  /** 父会话 id（子代理 / sidechain） */
  parentId?: string;
  cwd?: string;
  /** 第一条用户提问（截断） */
  title?: string;
  phase: LastPhase;
  /** 最后一步的简短描述（工具名 / 最后一句回复） */
  detail?: string;
  /** 最后事件的时间戳（ms）；没有则 undefined */
  lastAt?: number;
}

export interface ParseResult {
  status: AgentStatus;
  summary?: string;
}

const TAIL = 64 * 1024;

/** 读字符串尾部（兼容旧调用） */
export function readTail(content: string, max = TAIL): string {
  if (content.length <= max) return content;
  return content.slice(content.length - max);
}

export function jsonlEvents(text: string, limit = 400): Array<Record<string, unknown>> {
  const lines = text.split('\n').filter((l) => l.trim().startsWith('{'));
  const out: Array<Record<string, unknown>> = [];
  for (const line of lines.slice(-limit)) {
    try {
      const v = JSON.parse(line) as unknown;
      if (v && typeof v === 'object') out.push(v as Record<string, unknown>);
    } catch {
      /* 被截断的首行 / 半行 */
    }
  }
  return out;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const ts = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const n = Date.parse(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

/** 清理用户提问作为标题：去掉命令包装 / 系统注入，压成一行 */
export function cleanTitle(raw: string | undefined, max = 80): string | undefined {
  if (!raw) return undefined;
  let s = raw;
  // Claude Code 的 slash 命令包装 / 本地命令输出
  if (/^\s*<(command-name|local-command-stdout|command-message|system-reminder)/.test(s)) {
    const m = /<command-name>([^<]+)<\/command-name>/.exec(s);
    const args = /<command-args>([^<]*)<\/command-args>/.exec(s);
    if (!m) return undefined;
    s = `${m[1]} ${args?.[1] ?? ''}`;
  }
  // Codex 注入的环境 / 指令块
  if (/^\s*<(environment_context|user_instructions|INSTRUCTIONS)/i.test(s)) return undefined;
  if (/^\s*#\s*AGENTS\.md/i.test(s)) return undefined;
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function contentText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const c of content) {
      const o = c as Record<string, unknown>;
      if ((o.type === 'text' || o.type === 'input_text') && typeof o.text === 'string')
        return o.text;
    }
  }
  return undefined;
}

function hasType(content: unknown, type: string): boolean {
  return (
    Array.isArray(content) && content.some((c) => (c as Record<string, unknown>)?.type === type)
  );
}

function toolName(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const c of content) {
    const o = c as Record<string, unknown>;
    if (o?.type === 'tool_use' && typeof o.name === 'string') return o.name;
  }
  return undefined;
}

// ---------------------------------------------------------------- Claude Code

/** head: 文件开头若干 KB（拿 sessionId / cwd / 第一条提问）；tail: 文件结尾若干 KB */
export function parseClaudeSession(head: string, tail: string): SessionInfo {
  const info: SessionInfo = { phase: 'unknown' };
  for (const e of jsonlEvents(head, 200)) {
    info.sessionId ??= str(e.sessionId);
    info.cwd ??= str(e.cwd);
    if (e.isSidechain === true && !info.parentId) info.parentId = str(e.sessionId);
    if (!info.title && e.type === 'user' && e.isMeta !== true && e.isSidechain !== true) {
      const msg = e.message as Record<string, unknown> | undefined;
      if (msg && !hasType(msg.content, 'tool_result'))
        info.title = cleanTitle(contentText(msg.content));
    }
    if (!info.title && e.type === 'summary') info.title = cleanTitle(str(e.summary));
  }

  const events = jsonlEvents(tail);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const t = String(e.type ?? '');
    info.sessionId ??= str(e.sessionId);
    info.cwd ??= str(e.cwd);
    if (t === 'result') {
      // stream-json / -p 模式
      const err = e.is_error === true || String(e.subtype ?? '').startsWith('error');
      info.phase = err ? 'error' : 'task-done';
      info.detail = str(e.result) ?? str(e.error);
      info.lastAt = ts(e.timestamp);
      break;
    }
    if (t === 'assistant') {
      const msg = (e.message ?? {}) as Record<string, unknown>;
      const stop = str(msg.stop_reason);
      const tool = toolName(msg.content);
      info.lastAt = ts(e.timestamp);
      if (e.isApiErrorMessage === true || msg.model === '<synthetic>') {
        info.phase = 'error';
        info.detail = cleanTitle(contentText(msg.content), 120);
      } else if (tool || stop === 'tool_use') {
        info.phase = 'tool';
        info.detail = tool;
      } else if (stop === 'end_turn' || stop === 'stop_sequence' || stop === 'max_tokens') {
        info.phase = 'turn-done';
        info.detail = cleanTitle(contentText(msg.content), 120);
      } else {
        // 流式写入中（stop_reason 还是 null）
        info.phase = 'working';
      }
      break;
    }
    if (t === 'user') {
      const msg = (e.message ?? {}) as Record<string, unknown>;
      info.lastAt = ts(e.timestamp);
      // 工具结果回来了 → 模型在继续；用户刚提问 → 模型在想
      info.phase = 'working';
      if (hasType(msg.content, 'tool_result')) info.detail = 'tool_result';
      // 用户中断（[Request interrupted by user]）
      const txt = contentText(msg.content) ?? '';
      if (/\[Request interrupted by user/i.test(txt)) info.phase = 'turn-done';
      break;
    }
    if (t === 'progress' || t === 'tool_use' || t === 'tool_result') {
      info.phase = 'tool';
      info.lastAt = ts(e.timestamp);
      break;
    }
    // system / summary / file-history-snapshot … 继续往前找
  }
  return info;
}

// ---------------------------------------------------------------- Codex CLI

export function parseCodexSession(head: string, tail: string): SessionInfo {
  const info: SessionInfo = { phase: 'unknown' };
  for (const e of jsonlEvents(head, 200)) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (e.type === 'session_meta') {
      info.sessionId ??= str(p.id);
      info.cwd ??= str(p.cwd);
    }
    // 旧格式第一行就是 meta：{ id, timestamp, instructions }
    if (!e.type && str(e.id)) info.sessionId ??= str(e.id);
    if (!info.title && e.type === 'event_msg' && p.type === 'user_message')
      info.title = cleanTitle(str(p.message));
    if (!info.title && e.type === 'response_item' && p.type === 'message' && p.role === 'user')
      info.title = cleanTitle(contentText(p.content));
    if (e.type === 'thread.started') info.sessionId ??= str(e.thread_id);
  }

  const events = jsonlEvents(tail);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const t = String(e.type ?? '');
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const pt = String(p.type ?? '');
    const at = ts(e.timestamp);
    // 新格式
    if (t === 'event_msg') {
      if (pt === 'task_complete') {
        info.phase = 'turn-done';
        info.detail = cleanTitle(str(p.last_agent_message), 120);
        info.lastAt = at;
        break;
      }
      if (pt === 'error' || pt === 'stream_error' || pt === 'turn_aborted') {
        info.phase = pt === 'turn_aborted' ? 'turn-done' : 'error';
        info.detail = str(p.message) ?? str(p.reason);
        info.lastAt = at;
        break;
      }
      if (
        pt === 'exec_command_begin' ||
        pt === 'patch_apply_begin' ||
        pt === 'mcp_tool_call_begin'
      ) {
        info.phase = 'tool';
        info.detail = pt.replace(/_begin$/, '');
        info.lastAt = at;
        break;
      }
      if (pt === 'task_started' || pt === 'user_message' || pt === 'agent_reasoning') {
        info.phase = 'working';
        info.lastAt = at;
        break;
      }
      if (pt === 'token_count') continue;
      if (pt === 'agent_message') {
        info.phase = 'working';
        info.detail = cleanTitle(str(p.message), 120);
        info.lastAt = at;
        break;
      }
      continue;
    }
    if (t === 'response_item') {
      if (pt === 'function_call' || pt === 'local_shell_call' || pt === 'custom_tool_call') {
        info.phase = 'tool';
        info.detail = str(p.name) ?? pt;
      } else {
        info.phase = 'working';
      }
      info.lastAt = at;
      break;
    }
    // 旧格式 / exec --json
    if (t === 'turn.failed' || t === 'error') {
      info.phase = 'error';
      info.detail = str(e.message) ?? str((e.error as Record<string, unknown>)?.message);
      break;
    }
    if (t === 'turn.completed') {
      info.phase = 'turn-done';
      info.detail = str(e.message);
      break;
    }
    if (
      t === 'turn.started' ||
      t === 'item.started' ||
      t === 'item.completed' ||
      t === 'thread.started'
    ) {
      info.phase = t === 'item.started' ? 'tool' : 'working';
      break;
    }
  }
  return info;
}

// ---------------------------------------------------------------- Gemini CLI

export function parseGeminiSession(raw: string): SessionInfo {
  const info: SessionInfo = { phase: 'unknown' };
  try {
    const j = JSON.parse(raw) as {
      sessionId?: string;
      projectHash?: string;
      messages?: Array<Record<string, unknown>>;
      lastUpdated?: string;
    };
    info.sessionId = str(j.sessionId);
    const msgs = Array.isArray(j.messages) ? j.messages : [];
    const firstUser = msgs.find((m) => m.type === 'user');
    info.title = cleanTitle(contentText(firstUser?.content));
    const last = msgs[msgs.length - 1];
    info.lastAt = ts(last?.timestamp) ?? ts(j.lastUpdated);
    if (!last) return info;
    if (last.type === 'gemini' || last.type === 'model') {
      const calls = last.toolCalls as unknown[] | undefined;
      info.phase = Array.isArray(calls) && calls.length ? 'tool' : 'turn-done';
      info.detail = cleanTitle(contentText(last.content), 120);
    } else if (last.type === 'error') info.phase = 'error';
    else info.phase = 'working';
  } catch {
    /* 正在写入的半份 JSON */
  }
  return info;
}

// ---------------------------------------------------------------- Aider / Cline / Continue（旧接口保留）

/** Aider：`.aider.chat.history.md` */
export function parseAiderHistory(content: string): ParseResult {
  const tail = readTail(content, 16 * 1024);
  if (/Applied edit to /i.test(tail) || /Tokens:|Cost:/i.test(tail)) {
    return { status: 'running', summary: 'Aider 会话有更新' };
  }
  if (/^# aider chat started/im.test(tail)) {
    return { status: 'running', summary: 'Aider 会话中' };
  }
  return { status: 'idle' };
}

export function parseAiderAnalytics(tail: string): ParseResult {
  const events = jsonlEvents(tail, 40);
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = String(events[i].event ?? '');
    if (ev === 'exit') return { status: 'completed', summary: 'Aider 已退出' };
    if (ev === 'message_send' || ev === 'cli session' || ev === 'launched') {
      return { status: 'running', summary: 'Aider 运行中' };
    }
  }
  return { status: 'idle' };
}

/** Cline：`job.json` 或 NDJSON */
export function parseClineJob(raw: string): ParseResult {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const st = String(j.status ?? '').toLowerCase();
    if (st === 'completed' || st === 'success' || st === 'done') {
      return { status: 'completed', summary: String(j.command ?? 'Cline 任务完成').slice(0, 120) };
    }
    if (st === 'error' || st === 'failed' || st === 'timed_out') {
      return {
        status: 'failed',
        summary: String(j.error ?? j.command ?? 'Cline 失败').slice(0, 120),
      };
    }
    if (st === 'running' || st === 'active') {
      return { status: 'running', summary: String(j.command ?? 'Cline 运行中').slice(0, 120) };
    }
  } catch {
    /* not json object */
  }
  const events = jsonlEvents(raw, 40);
  for (let i = events.length - 1; i >= 0; i--) {
    const t = String(events[i].type ?? events[i].event ?? '');
    if (/error|fail/i.test(t)) return { status: 'failed' };
    if (/complete|done|result/i.test(t)) return { status: 'completed' };
    if (/start|progress|tool/i.test(t)) return { status: 'running' };
  }
  return { status: 'idle' };
}

/** Continue：`~/.continue/sessions/<id>.json` */
export function parseContinueSession(raw: string): ParseResult {
  try {
    const j = JSON.parse(raw) as { history?: unknown[]; title?: string };
    const hist = Array.isArray(j.history) ? j.history : [];
    if (!hist.length) return { status: 'idle' };
    const last = hist[hist.length - 1] as Record<string, unknown>;
    const msg = last.message as Record<string, unknown> | undefined;
    const role = String(msg?.role ?? last.role ?? '');
    if (role === 'assistant' || last.toolCallStates) {
      return { status: 'completed', summary: (j.title || 'Continue 会话').slice(0, 80) };
    }
    return { status: 'running', summary: (j.title || 'Continue 运行中').slice(0, 80) };
  } catch {
    return { status: 'idle' };
  }
}

/** ParseResult（旧接口：aider / cline / continue）→ LastPhase */
export function phaseOf(r: ParseResult): LastPhase {
  switch (r.status) {
    case 'running':
      return 'working';
    case 'completed':
      return 'task-done';
    case 'failed':
      return 'error';
    default:
      return 'unknown';
  }
}

// ---------------------------------------------------------------- 状态判定（纯函数）

export interface StatusInput {
  phase: LastPhase;
  /** 进程是否在跑（或无法判断时 undefined） */
  alive: boolean | undefined;
  /** 距最后写入的毫秒数 */
  ageMs: number;
  stallMs: number;
}

/**
 * 结合「最后事件语义 + 进程存活 + 写入新鲜度」得到状态。
 * - stalled 只在：进程活着 + 上一步是工具在跑 + 超过 stallMs 无写入
 * - 进程已退出：turn-done / task-done → completed；error → failed；其余 → idle（已结束）
 * - 进程状态未知（alive=undefined，如 Cursor 无法匹配）：只信写入新鲜度
 */
export function decideStatus(i: StatusInput): AgentStatus {
  const { phase, alive, ageMs, stallMs } = i;
  if (phase === 'error') return 'failed';
  if (alive === false) {
    if (phase === 'turn-done' || phase === 'task-done') return 'completed';
    return 'idle';
  }
  if (phase === 'task-done') return 'completed';
  if (phase === 'turn-done') return alive ? 'waiting' : ageMs < stallMs ? 'waiting' : 'idle';
  if (phase === 'working' || phase === 'tool') {
    if (ageMs <= stallMs) return 'running';
    // 只有「进程活着 + 上一步是工具在跑」才算卡住；其余长时间无写入视为空闲
    return alive === true && phase === 'tool' ? 'stalled' : 'idle';
  }
  // unknown
  if (alive === undefined) return ageMs < 60_000 ? 'running' : 'idle';
  return ageMs < 60_000 ? 'running' : 'waiting';
}

/**
 * dsh 会话索引：$DSH_HOME/storages/session_projcache/sessions/<id>.json
 * （会话正文 session.v4.jsonl.zstd 为压缩格式，只读这份明文索引）。
 * 运行状态由会话目录下 session.lock 是否被 flock 持有决定，这里只给标题 / cwd。
 */
export function parseDshProjcache(raw: string): Omit<SessionInfo, 'phase'> {
  try {
    const j = JSON.parse(raw) as {
      record?: {
        identity?: { cwd?: unknown; createdAt?: unknown };
        rows?: {
          title?: { val?: unknown };
          titleInput?: { val?: { first?: { text?: unknown } } };
        };
      };
    };
    const rows = j.record?.rows;
    const title =
      (typeof rows?.title?.val === 'string' && rows.title.val) ||
      (typeof rows?.titleInput?.val?.first?.text === 'string' && rows.titleInput.val.first.text) ||
      undefined;
    const cwd = j.record?.identity?.cwd;
    return {
      cwd: typeof cwd === 'string' ? cwd : undefined,
      title: title ? title.slice(0, 80) : undefined,
    };
  } catch {
    return {};
  }
}
