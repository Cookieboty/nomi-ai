/**
 * 编程工具会话日志 → 用量记录（纯函数，不碰文件系统）。
 *
 * 只读各工具自己写在本机的会话日志，不登录、不抓取任何账号。
 * 每个解析器都按「一个文本块」工作（增量游标只前进到完整行）；续读需要的上下文放在 state 里。
 * 字段口径统一为：input = 未命中缓存的输入，cacheRead / cacheWrite 另计，output 含推理 token。
 */
import path from 'node:path';

import type { QuotaWindow } from './quota';
import type { UsageRecord, UsageSource } from './types';

export type ParseState = Record<string, unknown>;

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

function parseTs(v: unknown): number {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

function lines(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const l of text.split('\n')) {
    const s = l.trim();
    if (!s || s[0] !== '{') continue;
    try {
      const o = JSON.parse(s) as unknown;
      const r = obj(o);
      if (r) out.push(r);
    } catch {
      /* 损坏行跳过 */
    }
  }
  return out;
}

const base = (p: unknown): string | undefined => {
  const s = str(p);
  return s ? path.basename(s.replace(/[\\/]+$/, '')) || undefined : undefined;
};

const empty = (r: Pick<UsageRecord, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>): boolean =>
  !r.input && !r.output && !r.cacheRead && !r.cacheWrite;

// ---------------------------------------------------------------- Claude Code

/**
 * `~/.claude/projects/<项目>/<会话>.jsonl`：type=assistant 的行带 message.usage。
 * 同一条消息会按内容块拆成多行（usage 相同或递增）→ 以 message.id 为键，块内先合并（每个字段取最大），
 * 账本里同键再取最大；续接会话会把旧消息复制进新文件 → 同键自然去重。
 * requestId 只在消息 id 缺失时当后备键（很多行没有它，不能当必需键）。
 *
 * 缓存写分档：cache_creation.ephemeral_1h_input_tokens 记进 cacheWrite1h，其余（5m 档 + 拆不出的余量）按 5 分钟档；
 * usage.speed === 'fast'（快速模式）打 fast 标记，计价时翻倍。
 */
export function parseClaudeChunk(text: string): UsageRecord[] {
  const out = new Map<string, UsageRecord>();
  for (const o of lines(text)) {
    if (o.type !== 'assistant') continue;
    const m = obj(o.message);
    const u = obj(m?.usage);
    if (!m || !u) continue;
    const model = str(m.model);
    if (!model || model === '<synthetic>') continue;
    const cc = obj(u.cache_creation);
    const w5m = num(cc?.ephemeral_5m_input_tokens);
    const w1hRaw = num(cc?.ephemeral_1h_input_tokens);
    // 总量字段优先；没有就用分档之和
    const cacheWrite = num(u.cache_creation_input_tokens) || w5m + w1hRaw;
    const rec = {
      input: num(u.input_tokens),
      output: num(u.output_tokens),
      cacheRead: num(u.cache_read_input_tokens),
      cacheWrite,
    };
    if (empty(rec)) continue;
    const cacheWrite1h = Math.min(w1hRaw, cacheWrite);
    const fast = u.speed === 'fast';
    const id = str(m.id) ?? str(o.requestId) ?? str(o.uuid);
    if (!id) continue;
    const session = str(o.sessionId);
    // Anthropic 的消息 id（msg_…）全局唯一；其它网关的 id 可能撞（chatcmpl-12），要带上会话
    const key = id.startsWith('msg_') || !session ? `claude:${id}` : `claude:${session}:${id}`;
    const prev = out.get(key);
    if (prev) {
      prev.input = Math.max(prev.input, rec.input);
      prev.output = Math.max(prev.output, rec.output);
      prev.cacheRead = Math.max(prev.cacheRead, rec.cacheRead);
      prev.cacheWrite = Math.max(prev.cacheWrite, rec.cacheWrite);
      const w = Math.min(Math.max(prev.cacheWrite1h ?? 0, cacheWrite1h), prev.cacheWrite);
      if (w) prev.cacheWrite1h = w;
      if (fast) prev.fast = true;
      continue;
    }
    out.set(key, {
      key,
      ts: parseTs(o.timestamp),
      source: 'claude',
      via: 'log',
      model,
      ...rec,
      ...(cacheWrite1h ? { cacheWrite1h } : {}),
      ...(fast ? { fast: true } : {}),
      session,
      project: base(o.cwd),
    });
  }
  return [...out.values()];
}

// ---------------------------------------------------------------- Codex

/** 分叉 rollout 开头「重放」父会话历史的行间距上限：重放是一次性写入，行间只差几毫秒；真实的第一轮至少隔数秒 */
const FORK_REPLAY_GAP_MS = 1000;

/**
 * `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`：
 * session_meta 给会话 id / cwd，turn_context 给模型，event_msg(token_count) 给每次请求的用量。
 * token_count 会因为额度信息刷新而重复出现 → 用累计 total_tokens 去重（只在增长时记一条）。
 * input_tokens 含缓存命中，这里拆成「未命中 + 缓存读」。
 *
 * fork / subagent：分叉出来的 rollout 第一行 session_meta 带 payload.forked_from_id，随后把父会话的历史
 * （含 token_count）整段重放进新文件。处理：
 * - 只有文件里的第一条 session_meta 描述本文件（重放进来的父 session_meta 不能覆盖会话 id / cwd）；
 * - 分叉文件开头那一段「行间距 < 1 秒」的连续行视为重放，其中的 token_count 不记账，
 *   遇到第一个 ≥ 1 秒的间隔就永久关闭跳过（真实的第一轮请求总是隔了数秒才出现）；
 *   重放行若保留了父会话的原时间戳（早于分叉时刻），同样不记账；
 * - 重放里的累计值照常推进 lastTotal，保证后面真实请求的去重基线正确。
 * 偏差方向：宁可多算几条重放行的边缘，也不丢真实用量（第一条重放行没有前瞻无法识别，见测试）。
 */
export function parseCodexChunk(text: string, state: ParseState): UsageRecord[] {
  const out: UsageRecord[] = [];
  for (const o of lines(text)) {
    const p = obj(o.payload);
    const lineTs = parseTs(o.timestamp);
    if (state.forked && state.replay) {
      const prev = state.prevTs as number | undefined;
      if (!lineTs || (prev !== undefined && (lineTs < prev || lineTs - prev >= FORK_REPLAY_GAP_MS)))
        state.replay = false;
      else state.prevTs = lineTs;
    }
    if (o.type === 'session_meta' && p) {
      if (!state.metaSeen && !state.sid) {
        state.metaSeen = true;
        state.sid = str(p.session_id) ?? str(p.id) ?? state.sid;
        state.cwd = str(p.cwd) ?? state.cwd;
        state.provider = str(p.model_provider) ?? state.provider;
        if (str(p.forked_from_id)) {
          state.forked = true;
          state.replay = true;
          if (lineTs) {
            state.prevTs = lineTs;
            state.forkTs = lineTs;
          }
        }
      }
    } else if (o.type === 'turn_context' && p) {
      state.model = str(p.model) ?? state.model;
      state.cwd = str(p.cwd) ?? state.cwd;
    } else if (o.type === 'event_msg' && p?.type === 'token_count') {
      const info = obj(p.info);
      const last = obj(info?.last_token_usage);
      const total = obj(info?.total_token_usage);
      if (!last) continue;
      const cum = num(total?.total_tokens);
      if (cum && cum === state.lastTotal) continue;
      if (cum) state.lastTotal = cum;
      // 继承自父会话的历史（父会话的日志里已经记过）：开头的密集重放段，或时间戳早于分叉时刻的行
      if (state.forked && (state.replay || (lineTs && lineTs < (state.forkTs as number) - 1000)))
        continue;
      const cached = num(last.cached_input_tokens);
      const write = num(last.cache_write_input_tokens);
      const rec = {
        input: Math.max(0, num(last.input_tokens) - cached - write),
        output: num(last.output_tokens),
        cacheRead: cached,
        cacheWrite: write,
      };
      if (empty(rec)) continue;
      const sid = (state.sid as string | undefined) ?? 'unknown';
      out.push({
        key: `codex:${sid}:${cum || lineTs}`,
        ts: lineTs,
        source: 'codex',
        via: 'log',
        provider: state.provider as string | undefined,
        model: (state.model as string | undefined) ?? 'unknown',
        ...rec,
        session: sid === 'unknown' ? undefined : sid,
        project: base(state.cwd),
      });
    }
  }
  return out;
}

/**
 * Codex 写在 token_count 事件里的额度快照（rate_limits.primary / secondary）：
 * 只读日志里已有的字段；字段缺失 / 类型不对的窗口直接丢掉，返回最后一条有效快照。
 * 重置时间：优先 resets_at（秒 / 毫秒时间戳），否则 事件时间 + resets_in_seconds。
 */
export function parseCodexRateLimits(
  text: string,
): { ts: number; windows: QuotaWindow[]; plan?: string } | null {
  if (!text.includes('rate_limits')) return null;
  let best: { ts: number; windows: QuotaWindow[]; plan?: string } | null = null;
  for (const o of lines(text)) {
    const p = obj(o.payload);
    if (o.type !== 'event_msg' || p?.type !== 'token_count') continue;
    const rl = obj(p.rate_limits);
    if (!rl) continue;
    const ts = parseTs(o.timestamp);
    const windows: QuotaWindow[] = [];
    for (const id of ['primary', 'secondary']) {
      const w = obj(rl[id]);
      const used = w?.used_percent;
      if (!w || typeof used !== 'number' || !Number.isFinite(used) || used < 0) continue;
      const minutes = num(w.window_minutes);
      const at = parseTs(w.resets_at);
      const inSec = num(w.resets_in_seconds);
      const resetAt = at || (inSec && ts ? ts + inSec * 1000 : 0);
      windows.push({
        id,
        usedPercent: Math.min(100, used),
        ...(minutes ? { windowMinutes: minutes } : {}),
        ...(resetAt ? { resetAt } : {}),
      });
    }
    if (!windows.length) continue;
    if (!best || ts >= best.ts) best = { ts, windows, plan: str(rl.plan_type) };
  }
  return best;
}

// ---------------------------------------------------------------- dsh

/**
 * `$DSH_HOME/sessions/<cwd>/session-<uuid>/session.v4.jsonl(.zstd)`：
 * request/context 给 provider / 模型，assistant/message 的 data.usage 给用量；以 seq 为键。
 * V0 的 `session.jsonl` 同格式，由扫描器的路径规则一并匹配。
 *
 * 输入口径：inputTokens **不含**缓存读写（disjoint）。依据：仓库夹具 dsh-session.jsonl 里
 * totalTokens = inputTokens + outputTokens + cacheReadTokens（4651+3+3=4657、13+3+4656=4672），
 * 与调研结论一致。⚠ 只来自夹具与调研，尚未用本机真实 dsh 日志核对（本机没有 dsh 日志）；
 * cacheWriteTokens 是否同样不含于 inputTokens 也没有样本，这里按同口径处理。待真机核对。
 */
export function parseDshChunk(text: string, state: ParseState): UsageRecord[] {
  const out: UsageRecord[] = [];
  for (const o of lines(text)) {
    const d = obj(o.data);
    if (o.type === 'session') {
      state.sid = str(o.id) ?? state.sid;
      state.cwd = str(o.cwd) ?? state.cwd;
    } else if (o.type === 'request/context' && d) {
      state.model = str(d.model) ?? state.model;
      state.provider = str(d.provider) ?? state.provider;
    } else if (o.type === 'assistant/message' && d) {
      const u = obj(d.usage);
      if (!u) continue;
      const cacheRead = num(u.cacheReadTokens);
      const cacheWrite = num(u.cacheWriteTokens);
      const rec = {
        input: num(u.inputTokens),
        output: num(u.outputTokens),
        cacheRead,
        cacheWrite,
      };
      if (empty(rec)) continue;
      const sid = (state.sid as string | undefined) ?? 'unknown';
      out.push({
        key: `dsh:${sid}:${num(o.seq) || parseTs(o.time)}`,
        ts: parseTs(o.time),
        source: 'dsh',
        via: 'log',
        provider: state.provider as string | undefined,
        model: (state.model as string | undefined) ?? 'unknown',
        ...rec,
        session: sid === 'unknown' ? undefined : sid,
        project: base(state.cwd),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- Grok Build

/**
 * `$GROK_HOME/sessions/<cwd>/<uuid>/updates.jsonl`：只计 `sessionUpdate === "turn_completed"`
 * 且带 usage 的行（与公开资料 / ccusage 描述一致；官方 headless 文档确认 sessions 目录与 streaming-json，
 * 字段名以本地样本与社区文档为准，真机未逐字段核对 → 见调研结论）。
 *
 * 口径：inputTokens **含**缓存（OpenAI 风格）→ 拆成 uncached = input - cacheRead - cacheWrite；
 * reasoningTokens 是 output 子集，不另加。
 */
export function parseGrokChunk(text: string, state: ParseState): UsageRecord[] {
  const out: UsageRecord[] = [];
  for (const o of lines(text)) {
    // ACP 风格：params.update.sessionUpdate 或顶层 sessionUpdate
    const params = obj(o.params) ?? obj(o);
    const update = obj(params?.update) ?? params;
    const sessionUpdate =
      str(update?.sessionUpdate) ?? str(params?.sessionUpdate) ?? str(o.sessionUpdate);
    if (sessionUpdate !== 'turn_completed') {
      // 顺带记下模型（summary / modelUsage）
      const mu = obj(update?.modelUsage) ?? obj(params?.modelUsage);
      if (mu) {
        const keys = Object.keys(mu);
        if (keys[0]) state.model = keys[0];
      }
      const mid = str(update?.model) ?? str(params?.model) ?? str(o.model);
      if (mid) state.model = mid;
      const sid = str(o.sessionId) ?? str(params?.sessionId) ?? str(update?.sessionId);
      if (sid) state.sid = sid;
      continue;
    }
    const usage = obj(update?.usage) ?? obj(params?.usage) ?? obj(o.usage);
    if (!usage) continue;
    const cacheRead = num(usage.cachedReadTokens ?? usage.cacheReadTokens);
    const cacheWrite = num(usage.cacheCreationTokens ?? usage.cacheWriteTokens);
    const inputRaw = num(usage.inputTokens);
    // input 含缓存：拆出未命中部分（夹负为 0）
    const input = Math.max(0, inputRaw - cacheRead - cacheWrite);
    const output = num(usage.outputTokens);
    const rec = { input, output, cacheRead, cacheWrite };
    if (empty(rec)) continue;
    const meta = obj(params?._meta);
    const promptId =
      str(update?.prompt_id) ??
      str(update?.promptId) ??
      str(params?.prompt_id) ??
      str(meta?.promptId) ??
      String(num(o.seq) || parseTs(o.timestamp ?? o.time ?? update?.timestamp));
    const sid = (state.sid as string | undefined) ?? str(o.sessionId) ?? 'unknown';
    const modelFromUsage = obj(update?.modelUsage) ?? obj(params?.modelUsage);
    const modelKeys = modelFromUsage ? Object.keys(modelFromUsage) : [];
    out.push({
      key: `grok:${sid}:${promptId}`,
      ts: parseTs(o.timestamp ?? o.time ?? update?.timestamp),
      source: 'grok',
      via: 'log',
      provider: 'xai',
      model: modelKeys[0] ?? (state.model as string | undefined) ?? 'unknown',
      ...rec,
      session: sid === 'unknown' ? undefined : sid,
      project: base(state.cwd),
    });
  }
  return out;
}

// ---------------------------------------------------------------- Gemini CLI

/**
 * `~/.gemini/tmp/<项目>/chats/session-*.json`（旧，整份 JSON）或 `session-*.jsonl`（新，逐行追加）；
 * subagent 在 `chats/<父会话id>/<子会话id>.jsonl`。type=gemini 的消息带 tokens。
 *
 * jsonl：同一条消息（同 id）会被整行多次追加 → 按 id 取最后一条；没有 id 的消息按行号区分。
 * tokens：input 含缓存（要扣掉 cached）、output、thoughts（计入输出）、tool（工具调用提示词，按 API 语义记入输入）。
 * 尽力解析；格式未在真机逐版本核对。
 */
export function parseGeminiFile(
  text: string,
  fallbackCwd?: string,
  fallbackSession?: string,
): UsageRecord[] {
  let msgs: unknown[];
  let sid: string | undefined;
  let updated: unknown;
  let whole: unknown;
  try {
    whole = JSON.parse(text);
  } catch {
    whole = undefined;
  }
  const w = obj(whole);
  if (w && Array.isArray(w.messages)) {
    // 旧格式：整份 JSON
    msgs = w.messages as unknown[];
    sid = str(w.sessionId);
    updated = w.lastUpdated;
  } else {
    // 新格式：每行一个对象。消息行 / 头部行（带 sessionId）/ 可能的整份消息数组更新行
    const byId = new Map<string, unknown>();
    let n = 0;
    for (const o of lines(text)) {
      sid = sid ?? str(o.sessionId);
      updated = o.lastUpdated ?? updated;
      if (Array.isArray(o.messages)) {
        for (const x of o.messages as unknown[]) byId.set(str(obj(x)?.id) ?? `#${n++}`, x);
        continue;
      }
      if (o.type !== 'gemini' && o.type !== 'model') continue;
      byId.set(str(o.id) ?? `#${n++}`, o);
    }
    msgs = [...byId.values()];
  }
  const session = sid ?? fallbackSession ?? 'unknown';
  const out: UsageRecord[] = [];
  msgs.forEach((raw, i) => {
    const m = obj(raw);
    const t = obj(m?.tokens);
    if (!m || !t || (m.type !== 'gemini' && m.type !== 'model')) return;
    const cached = num(t.cached);
    const rec = {
      input: Math.max(0, num(t.input) - cached) + num(t.tool),
      output: num(t.output) + num(t.thoughts),
      cacheRead: cached,
      cacheWrite: 0,
    };
    if (empty(rec)) return;
    out.push({
      key: `gemini:${session}:${str(m.id) ?? i}`,
      ts: parseTs(m.timestamp) || parseTs(updated),
      source: 'gemini',
      via: 'log',
      model: str(m.model) ?? 'unknown',
      ...rec,
      session: session === 'unknown' ? undefined : session,
      project: base(fallbackCwd),
    });
  });
  return out;
}

// ---------------------------------------------------------------- Aider

/** `~/.aider/analytics.jsonl`：event=message_send 的 properties 带 prompt / completion tokens（尽力解析）。 */
export function parseAiderChunk(text: string): UsageRecord[] {
  const out: UsageRecord[] = [];
  for (const o of lines(text)) {
    if (o.event !== 'message_send') continue;
    const p = obj(o.properties);
    if (!p) continue;
    const rec = {
      input: num(p.prompt_tokens),
      output: num(p.completion_tokens),
      cacheRead: 0,
      cacheWrite: 0,
    };
    if (empty(rec)) continue;
    const ts = parseTs(o.time);
    out.push({
      key: `aider:${ts}:${rec.input}:${rec.output}`,
      ts,
      source: 'aider',
      via: 'log',
      model: str(p.main_model) ?? 'unknown',
      ...rec,
    });
  }
  return out;
}

// ---------------------------------------------------------------- Qwen Code

/**
 * `~/.qwen/tmp/<project_id>/chats/<sessionId>.jsonl`：type=assistant 的记录带 usageMetadata（Gemini API 口径）。
 * promptTokenCount 含缓存（cachedContentTokenCount 要扣掉），toolUsePromptTokenCount 是工具提示词（记入输入），
 * 输出 = candidatesTokenCount + thoughtsTokenCount。
 * 以记录 uuid 去重：/branch 等会把消息原样复制进另一个文件 → 同 uuid 只记一次（块内同 uuid 取各字段最大）。
 * ⚠ 字段只来自调研与上游源码阅读，未在真机日志上核对。
 */
export function parseQwenChunk(text: string): UsageRecord[] {
  const out = new Map<string, UsageRecord>();
  for (const o of lines(text)) {
    if (o.type !== 'assistant') continue;
    const u = obj(o.usageMetadata);
    const uuid = str(o.uuid);
    if (!u || !uuid) continue;
    const cached = num(u.cachedContentTokenCount);
    const rec = {
      input: Math.max(0, num(u.promptTokenCount) - cached) + num(u.toolUsePromptTokenCount),
      output: num(u.candidatesTokenCount) + num(u.thoughtsTokenCount),
      cacheRead: cached,
      cacheWrite: 0,
    };
    if (empty(rec)) continue;
    const key = `qwen:${uuid}`;
    const prev = out.get(key);
    if (prev) {
      prev.input = Math.max(prev.input, rec.input);
      prev.output = Math.max(prev.output, rec.output);
      prev.cacheRead = Math.max(prev.cacheRead, rec.cacheRead);
      continue;
    }
    out.set(key, {
      key,
      ts: parseTs(o.timestamp),
      source: 'qwen',
      via: 'log',
      model: str(o.model) ?? 'unknown',
      ...rec,
      session: str(o.sessionId),
      project: base(o.cwd),
    });
  }
  return [...out.values()];
}

// ---------------------------------------------------------------- Kimi

/** Kimi 的 token 字段：新旧两种命名（snake / camel）都是「不含缓存的输入」；OpenAI 风格的 input_tokens 才需要扣缓存 */
function kimiTokens(
  u: Record<string, unknown>,
): Pick<UsageRecord, 'input' | 'output' | 'cacheRead' | 'cacheWrite'> {
  if (u.inputOther != null || u.input_other != null) {
    return {
      input: num(u.inputOther ?? u.input_other),
      output: num(u.output),
      cacheRead: num(u.inputCacheRead ?? u.input_cache_read),
      cacheWrite: num(u.inputCacheCreation ?? u.input_cache_creation),
    };
  }
  const details = obj(u.input_tokens_details);
  const hasRead = u.cache_read_input_tokens != null;
  const cacheRead = num(u.cache_read_input_tokens ?? details?.cached_tokens);
  return {
    input: Math.max(0, num(u.input_tokens) - (hasRead ? 0 : cacheRead)),
    output: num(u.output_tokens),
    cacheRead,
    cacheWrite: num(u.cache_creation_input_tokens),
  };
}

/**
 * Kimi 本地会话 `wire.jsonl`，两代格式：
 * - 旧 kimi-cli（`~/.kimi/sessions/<工作区哈希>/<会话>/wire.jsonl`）：`{timestamp(秒), message:{type:'StatusUpdate',
 *   payload:{message_id, token_usage:{input_other, input_cache_read, input_cache_creation, output}}}}`；
 * - Kimi Code（`~/.kimi-code/sessions/<会话>/agents/<agent>/wire.jsonl`）：`step.end` 事件（可包在
 *   `context.append_loop_event` 里）带 `usage:{inputOther, inputCacheRead, inputCacheCreation, output}`、`messageId`，时间 `time`(ms)。
 * 模型名取 wire 里最近的 `llm.request / config.update / profile.bind` 的 modelAlias（旧格式没有则为 unknown；
 * 不读 config.toml —— 里面可能有密钥）。以消息 id（没有就用 step uuid）去重，迁移 / 复制的会话只记一次。
 * state.sid 由扫描器按路径预置。⚠ 字段只来自调研，未在真机日志上核对。
 */
export function parseKimiChunk(text: string, state: ParseState): UsageRecord[] {
  const out = new Map<string, UsageRecord>();
  for (const o of lines(text)) {
    const type = str(o.type);
    if (type === 'llm.request' || type === 'config.update' || type === 'profile.bind') {
      const m = str(o.modelAlias) ?? str(o.model);
      if (m) state.model = m.split('/').pop();
    }
    const msg = obj(o.message);
    const event = type === 'context.append_loop_event' ? obj(o.event) : o;
    let usage: Record<string, unknown> | undefined;
    let id: string | undefined;
    let ts = 0;
    if (msg?.type === 'StatusUpdate') {
      const p = obj(msg.payload);
      usage = obj(p?.token_usage);
      id = str(p?.message_id);
      ts = parseTs(o.timestamp);
    } else if (event?.type === 'step.end') {
      usage = obj(event.usage);
      id = str(event.messageId) ?? str(event.uuid);
      ts = parseTs(o.time ?? event.time);
    }
    if (!usage || !id) continue;
    const rec = kimiTokens(usage);
    if (empty(rec) || !ts) continue;
    const key = `kimi:${id}`;
    const prev = out.get(key);
    if (prev) {
      prev.input = Math.max(prev.input, rec.input);
      prev.output = Math.max(prev.output, rec.output);
      prev.cacheRead = Math.max(prev.cacheRead, rec.cacheRead);
      prev.cacheWrite = Math.max(prev.cacheWrite, rec.cacheWrite);
      continue;
    }
    out.set(key, {
      key,
      ts,
      source: 'kimi',
      via: 'log',
      model: (state.model as string | undefined) ?? 'unknown',
      ...rec,
      session: state.sid as string | undefined,
    });
  }
  return [...out.values()];
}

// ---------------------------------------------------------------- SQLite 来源（行 → 记录，纯函数）

const cell = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : num(v));
const sv = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * OpenCode `opencode.db` 的 message 表（只 SELECT 记账列，用 json_extract 取 data 里的字段）：
 * assistant 消息的 tokens.input / output / reasoning / cache.read / cache.write。
 * input 视为不含缓存（disjoint）；推理 token 按输出计价，并入 output。以消息 id 为键。
 * ⚠ 列名 / 口径来自调研，未在真机核对；v2（session_message 表）暂不支持。
 */
export interface OpencodeRow {
  id?: unknown;
  session_id?: unknown;
  created?: unknown;
  model?: unknown;
  provider?: unknown;
  input?: unknown;
  output?: unknown;
  reasoning?: unknown;
  cache_read?: unknown;
  cache_write?: unknown;
  cwd?: unknown;
}

export function opencodeRowToRecord(r: OpencodeRow): UsageRecord | null {
  const id = sv(r.id);
  if (!id) return null;
  const rec = {
    input: cell(r.input),
    output: cell(r.output) + cell(r.reasoning),
    cacheRead: cell(r.cache_read),
    cacheWrite: cell(r.cache_write),
  };
  if (empty(rec)) return null;
  const ts = parseTs(cell(r.created));
  if (!ts) return null;
  return {
    key: `opencode:${id}`,
    ts,
    source: 'opencode',
    via: 'log',
    provider: sv(r.provider),
    model: sv(r.model) ?? 'unknown',
    ...rec,
    session: sv(r.session_id),
    project: base(r.cwd),
  };
}

/**
 * Copilot CLI `session-store.db` 的 assistant_usage_events（每次 LLM 请求一行）：
 * input_tokens 含缓存读写（扣掉 cache_read_tokens / cache_write_tokens），output_tokens 已含推理。
 * 以行 id 为键（带会话 id）。⚠ 列名 / 口径来自调研，未在真机核对。
 */
export interface CopilotRow {
  id?: unknown;
  session_id?: unknown;
  model?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_tokens?: unknown;
  cache_write_tokens?: unknown;
  created_at?: unknown;
}

export function copilotRowToRecord(r: CopilotRow): UsageRecord | null {
  const id = cell(r.id);
  const session = sv(r.session_id);
  if (!id || !session) return null;
  const total = cell(r.input_tokens);
  const cacheRead = Math.min(cell(r.cache_read_tokens), total);
  const cacheWrite = Math.min(cell(r.cache_write_tokens), total - cacheRead);
  const rec = {
    input: total - cacheRead - cacheWrite,
    output: cell(r.output_tokens),
    cacheRead,
    cacheWrite,
  };
  if (empty(rec)) return null;
  const ts = parseTs(
    typeof r.created_at === 'string' && /^\d+$/.test(r.created_at)
      ? Number(r.created_at)
      : r.created_at,
  );
  if (!ts) return null;
  return {
    key: `copilot:${session}:${id}`,
    ts,
    source: 'copilot',
    via: 'log',
    model: sv(r.model) ?? 'unknown',
    ...rec,
    session,
  };
}

export const LOG_SOURCES: UsageSource[] = [
  'claude',
  'codex',
  'dsh',
  'grok',
  'gemini',
  'qwen',
  'opencode',
  'copilot',
  'kimi',
  'aider',
];
