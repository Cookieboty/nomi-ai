import { SDKError, SDKErrorCodes, type AppClient } from '@nomi-ai/ai-sdk-client';
import { t } from '@nomi-ai/ui';

import type { ChatMessage } from '../types/chat';
import { normalizePlanEntries } from '../utils/toolTrace';

import { stripInlineTextForPathAttachments } from './fileAttachments';
import type { HarnessTraceEvent } from './harnessClient';

type Port = Pick<AppClient, 'conversations' | 'on'>;
export type ManagedRuntimeState = Awaited<ReturnType<Port['conversations']['runtimeState']>>;
export type ManagedSendOptions = {
  images?: string[];
  messageId?: string;
  turnId?: string;
  retry?: { messageId: string; turnId: string };
};

export function createManagedMessageId(): string {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

const RUNTIME_BUDGET_RE =
  /conversationruntime:\s+.+?\s+is\s+(\d+)\s+serialized UTF-8 bytes,\s+budget is\s+(\d+)/i;

function errorCodeOf(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') {
    return err.code;
  }
  return '';
}

function formatByteCount(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isRequestTooLargeError(err: unknown): boolean {
  const code = errorCodeOf(err);
  const msg = err instanceof Error ? err.message : String(err);
  return (
    code === 'RUNTIME_REQUEST_TOO_LARGE' ||
    msg.includes('RUNTIME_REQUEST_TOO_LARGE') ||
    RUNTIME_BUDGET_RE.test(msg)
  );
}

export function formatManagedRuntimeError(err: unknown): string {
  const code = errorCodeOf(err);
  const msg = err instanceof Error ? err.message : String(err);
  if (code === 'RUNTIME_BUSY' || msg.includes('RUNTIME_BUSY')) {
    return t('ui.chat-settings.managed-error-busy');
  }
  if (code === 'RUNTIME_STALE' || msg.includes('RUNTIME_STALE')) {
    return t('ui.chat-settings.managed-error-stale');
  }
  if (code === 'RUNTIME_UNAVAILABLE' || msg.includes('RUNTIME_UNAVAILABLE')) {
    return t('ui.chat-settings.managed-error-unavailable');
  }
  if (isRequestTooLargeError(err)) {
    const m = RUNTIME_BUDGET_RE.exec(msg);
    if (m) {
      const need = Number(m[1]);
      const limit = Number(m[2]);
      if (Number.isFinite(need) && Number.isFinite(limit) && limit > 0) {
        return t(
          'ui.chat-settings.managed-error-request-too-large',
          formatByteCount(need),
          formatByteCount(limit),
        );
      }
    }
    return t('ui.chat-settings.managed-error-request-too-large-generic');
  }
  return msg;
}

export function wrapManagedSendError(err: unknown): Error {
  if (isRequestTooLargeError(err)) {
    return new SDKError(SDKErrorCodes.E_REQUEST_TOO_LARGE, formatManagedRuntimeError(err), {
      retryable: false,
      hint: 'dismiss',
      cause: err,
    });
  }
  return err instanceof Error ? err : new Error(String(err));
}

export function isAutoAbandonableState(
  state:
    | {
        phase?: string;
        recovery?: string;
        pendingSwitch?: unknown;
      }
    | null
    | undefined,
): boolean {
  if (!state || state.pendingSwitch) return false;
  return (
    (state.phase === 'uncertain' && state.recovery !== 'unknown') ||
    (state.phase === 'canceled' && state.recovery === 'unknown')
  );
}

function buildDraftTrace(state: ManagedRuntimeState): HarnessTraceEvent[] | undefined {
  const out: HarnessTraceEvent[] = [];
  if (state.thinking) {
    out.push({ type: 'thinking', text: state.thinking });
  }
  for (const tr of state.trace ?? []) {
    if (tr.kind === 'agent') continue;
    if (tr.kind === 'plan-removed') {
      const targetId = tr.detail?.trim() || 'default';
      for (let i = out.length - 1; i >= 0; i--) {
        const cur = out[i]!;
        if (cur.type === 'plan' && (cur.planId || 'default') === targetId) {
          out.splice(i, 1);
        }
      }
      continue;
    }
    if (tr.kind === 'thinking') {
      const text = tr.detail || tr.summary;
      if (text) {
        out.push({
          type: 'thinking',
          text,
          ...(tr.at ? { at: tr.at } : {}),
          ...(tr.textAt !== undefined ? { textAt: tr.textAt } : {}),
        });
      }
      continue;
    }
    if (tr.kind === 'plan') {
      if (!tr.detail) continue;
      let parsed: Record<string, unknown> | null = null;
      try {
        const v = JSON.parse(tr.detail) as unknown;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          parsed = v as Record<string, unknown>;
        }
      } catch {
        continue;
      }
      if (!parsed) continue;
      const entries = normalizePlanEntries(parsed.entries);
      const planId = typeof parsed.planId === 'string' ? parsed.planId.trim() : '';
      const markdown = typeof parsed.markdown === 'string' ? parsed.markdown.trim() : '';
      const uri = typeof parsed.uri === 'string' ? parsed.uri.trim() : '';
      if (!entries.length && !markdown && !uri) continue;
      out.push({
        type: 'plan',
        entries,
        ...(planId ? { planId } : {}),
        ...(markdown ? { markdown } : {}),
        ...(uri ? { uri } : {}),
        ...(tr.at ? { at: tr.at } : {}),
        ...(tr.textAt !== undefined ? { textAt: tr.textAt } : {}),
      });
      continue;
    }
    const status =
      tr.status === 'completed' || tr.status === 'done'
        ? 'done'
        : tr.status === 'error' || tr.status === 'failed' || tr.status === 'denied'
          ? 'error'
          : 'start';
    const name = tr.tool || tr.summary || tr.kind || 'tool';
    out.push({
      type: 'tool',
      id: tr.id,
      name,
      status,
      ...(tr.detail ? { input: tr.detail } : {}),
      ...(tr.output ? { output: tr.output } : {}),
      ...(tr.at ? { at: tr.at } : {}),
      ...(tr.textAt !== undefined ? { textAt: tr.textAt } : {}),
    });
  }
  return out.length ? out : undefined;
}

const ADMISSION_TIMEOUT_MS = 120_000;
const OBSERVATION_PROBE_INTERVAL_MS = 120_000;
const PROBE_TIMEOUT_MS = 15_000;

/** Reads only authoritative projection. Never upserts user/assistant view copies. */
export async function sendManagedConversation(
  api: Port,
  id: string,
  text: string,
  onUpdate: (messages: ChatMessage[]) => void,
  signal?: AbortSignal,
  options?: ManagedSendOptions,
): Promise<void> {
  let initial = await api.conversations.runtimeState({ id });
  if (isAutoAbandonableState(initial) && typeof api.conversations.runtimeResolve === 'function') {
    initial = await api.conversations.runtimeResolve({
      id,
      decision: 'abandon',
      confirm: true,
      expectedGeneration: initial.generation,
    });
  }
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const messageId = options?.retry?.messageId ?? options?.messageId ?? createManagedMessageId();
  const turnId = options?.retry?.turnId ?? options?.turnId ?? `turn_${messageId}`;
  let token: Awaited<ReturnType<Port['conversations']['runtimeSend']>> | undefined;
  let events: ManagedRuntimeState[] = [];
  let revision = 0;
  let baseMessages: ChatMessage[] | null = null;
  let draftStartedAt = 0;
  let settled = false;
  let terminalSeen = false;
  let probing = false;
  let admissionTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const done = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  // Attach a rejection handler before an IPC response can race a fast event.
  void done.catch(() => undefined);
  const failTimeout = (): void => {
    if (!settled) {
      reject(new Error(t('ui.chat-settings.managed-observation-timeout')));
    }
  };
  const isMatchingAttempt = (state: ManagedRuntimeState): boolean =>
    Boolean(
      token &&
      state.id === id &&
      state.token?.attemptId === token.attemptId &&
      state.token.generation === token.generation &&
      state.token.conversationId === id,
    );
  const clearTimers = (): void => {
    if (admissionTimer !== undefined) {
      clearTimeout(admissionTimer);
      admissionTimer = undefined;
    }
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    if (probeTimer !== undefined) {
      clearTimeout(probeTimer);
      probeTimer = undefined;
    }
  };
  const armIdleProbe = (): void => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    if (!settled && token) {
      idleTimer = setTimeout(() => {
        idleTimer = undefined;
        void probeRuntime();
      }, OBSERVATION_PROBE_INTERVAL_MS);
    }
  };
  const accept = async (state: ManagedRuntimeState): Promise<void> => {
    if (state.id !== id) return;
    if (!token) {
      events.push(state);
      return;
    }
    if (!isMatchingAttempt(state) || settled) return;
    const terminal = ['completed', 'canceled', 'uncertain', 'failed-pre-submit'].includes(
      state.phase,
    );
    if (terminalSeen && !terminal) return;
    terminalSeen ||= terminal;
    if (!terminal) {
      armIdleProbe();
    }
    const own = ++revision;
    let messages: ChatMessage[];
    if (state.phase === 'running' && baseMessages !== null) {
      messages = baseMessages;
    } else {
      const result = await api.conversations.messages({ id });
      if (own !== revision || settled) return;
      messages = result.messages as unknown as ChatMessage[];
      if (state.phase === 'running') {
        baseMessages = messages;
      } else {
        baseMessages = null;
      }
    }
    const draftTrace = buildDraftTrace(state);
    const hasDraft =
      state.phase === 'running' &&
      Boolean(state.partial || state.thinking || state.thinkingActive || draftTrace?.length);
    if (hasDraft && !draftStartedAt) {
      draftStartedAt = Date.now();
    }
    onUpdate(
      hasDraft
        ? [
            ...messages,
            {
              id: `draft_${token.attemptId}`,
              role: 'assistant',
              content: state.partial || '',
              timestamp: draftStartedAt,
              ...(state.backend ? { runtimeBackend: state.backend } : {}),
              ...(state.model && state.model !== 'cli-default' && state.model !== 'chat-route'
                ? { modelId: state.model }
                : {}),
              ...(draftTrace?.length ? { trace: draftTrace } : {}),
              ...(state.thinkingActive ? { thinking: true } : {}),
            },
          ]
        : messages,
    );
    if (state.phase === 'completed' || state.phase === 'canceled') {
      settled = true;
      resolve();
    } else if (state.phase === 'uncertain' || state.phase === 'failed-pre-submit') {
      settled = true;
      const detail = state.detail || state.phase;
      if (isAutoAbandonableState(state) && typeof api.conversations.runtimeResolve === 'function') {
        await api.conversations
          .runtimeResolve({
            id,
            decision: 'abandon',
            confirm: true,
            expectedGeneration: state.generation,
          })
          .catch(() => undefined);
      }
      reject(wrapManagedSendError(new Error(detail)));
    }
  };
  const update = (state: ManagedRuntimeState): void => {
    void accept(state).catch(reject);
  };
  async function probeRuntime(): Promise<void> {
    if (settled || !token || probing) return;
    probing = true;
    try {
      const state = await Promise.race([
        api.conversations.runtimeState({ id }),
        new Promise<never>((_, fail) => {
          probeTimer = setTimeout(
            () => fail(new Error(t('ui.chat-settings.managed-observation-timeout'))),
            PROBE_TIMEOUT_MS,
          );
        }),
      ]);
      if (settled) return;
      if (!isMatchingAttempt(state)) {
        failTimeout();
        return;
      }
      if (['completed', 'canceled', 'uncertain', 'failed-pre-submit'].includes(state.phase)) {
        update(state);
        return;
      }
      if (state.phase === 'running') {
        armIdleProbe();
        update(state);
        return;
      }
      failTimeout();
    } catch {
      failTimeout();
    } finally {
      if (probeTimer !== undefined) {
        clearTimeout(probeTimer);
        probeTimer = undefined;
      }
      probing = false;
    }
  }
  const off = api.on('conversations.runtimeChanged', update);
  const cancel = (): void => {
    void api.conversations
      .runtimeCancel({ id, turnId, beforeGeneration: initial.generation })
      .then(update, reject);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  admissionTimer = setTimeout(() => {
    if (!token) failTimeout();
  }, ADMISSION_TIMEOUT_MS);
  try {
    const isCliBackend = Boolean(initial.backend && initial.backend !== 'api');
    const wireText =
      !options?.retry && isCliBackend ? stripInlineTextForPathAttachments(text) : text;
    token = await Promise.race([
      api.conversations.runtimeSend({
        id,
        messageId,
        turnId,
        text: wireText,
        expectedGeneration: initial.generation,
        ...(options?.images?.length ? { images: options.images } : {}),
        ...(options?.retry ? { retry: true } : {}),
      }),
      done.then((): never => {
        throw new Error(t('ui.chat-settings.managed-observation-timeout'));
      }),
    ]);
    if (admissionTimer !== undefined) {
      clearTimeout(admissionTimer);
      admissionTimer = undefined;
    }
    armIdleProbe();
    const buffered = events;
    events = [];
    for (const event of buffered) update(event);
    if (signal?.aborted) cancel();
    // A slow reconciliation query must not hide an already observed terminal event.
    void api.conversations.runtimeState({ id }).then(update, reject);
    await done;
  } catch (err) {
    throw wrapManagedSendError(err);
  } finally {
    settled = true;
    clearTimers();
    signal?.removeEventListener('abort', cancel);
    off();
  }
}

export async function rewindManagedConversation(
  api: Port,
  id: string,
  messageId: string,
): Promise<ChatMessage[]> {
  let initial = await api.conversations.runtimeState({ id });
  if (isAutoAbandonableState(initial) && typeof api.conversations.runtimeResolve === 'function') {
    initial = await api.conversations.runtimeResolve({
      id,
      decision: 'abandon',
      confirm: true,
      expectedGeneration: initial.generation,
    });
  }
  await api.conversations.runtimeRewind({
    id,
    messageId,
    expectedGeneration: initial.generation,
  });
  const result = await api.conversations.messages({ id });
  return result.messages as unknown as ChatMessage[];
}

export async function switchManagedRuntime(
  api: Pick<AppClient, 'conversations'>,
  input: Parameters<Port['conversations']['runtimeSwitch']>[0],
): Promise<ManagedRuntimeState> {
  return api.conversations.runtimeSwitch(input);
}

export async function resolveManagedRuntime(
  api: Pick<AppClient, 'conversations'>,
  input: Parameters<Port['conversations']['runtimeResolve']>[0],
): Promise<ManagedRuntimeState> {
  return api.conversations.runtimeResolve(input);
}

export async function updateManagedConversationMeta(
  api: Pick<AppClient, 'conversations'>,
  id: string,
  patch: {
    name?: string;
    autoTitle?: boolean;
    pinnedAt?: number | null;
    archivedAt?: number | null;
    reasoningEffort?: string | null;
    longContext?: { model: string; on: boolean } | null;
  },
): Promise<void> {
  await api.conversations.runtimeUpdateMeta({ id, ...patch });
}
