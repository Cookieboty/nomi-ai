import type { AppClient } from '@nomi-ai/ai-sdk-client';
import { t } from '@nomi-ai/ui';

import type { ChatMessage } from '../types/chat';

type Port = Pick<AppClient, 'conversations' | 'on'>;
export type ManagedRuntimeState = Awaited<ReturnType<Port['conversations']['runtimeState']>>;
export type ManagedSendOptions = {
  images?: string[];
  retry?: { messageId: string; turnId: string };
};

export function formatManagedRuntimeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('RUNTIME_BUSY')) return t('ui.chat-settings.managed-error-busy');
  if (msg.includes('RUNTIME_STALE')) return t('ui.chat-settings.managed-error-stale');
  if (msg.includes('RUNTIME_UNAVAILABLE')) return t('ui.chat-settings.managed-error-unavailable');
  return msg;
}

function formatTraceSummary(trace: ManagedRuntimeState['trace']): string {
  if (!trace?.length) return '';
  const latest = trace[trace.length - 1]!;
  const label = latest.tool || latest.summary || latest.kind;
  if (!label) return '';
  return latest.status === 'running' || latest.status === 'start'
    ? t('ui.chat-settings.managed-trace-running', label)
    : t('ui.chat-settings.managed-trace-done', label);
}

/** Reads only authoritative projection. Never upserts user/assistant view copies. */
export async function sendManagedConversation(
  api: Port,
  id: string,
  text: string,
  onUpdate: (messages: ChatMessage[]) => void,
  signal?: AbortSignal,
  options?: ManagedSendOptions,
): Promise<void> {
  const initial = await api.conversations.runtimeState({ id });
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const messageId =
    options?.retry?.messageId ??
    `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const turnId = options?.retry?.turnId ?? `turn_${messageId}`;
  let token: Awaited<ReturnType<Port['conversations']['runtimeSend']>> | undefined;
  let events: ManagedRuntimeState[] = [];
  let revision = 0;
  let settled = false;
  let terminalSeen = false;
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const done = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  // Attach a rejection handler before an IPC response can race a fast event.
  void done.catch(() => undefined);
  const accept = async (state: ManagedRuntimeState): Promise<void> => {
    if (state.id !== id) return;
    if (!token) {
      events.push(state);
      return;
    }
    if (
      state.id !== id ||
      state.token?.attemptId !== token.attemptId ||
      state.token.generation !== token.generation ||
      state.token.conversationId !== id ||
      settled
    )
      return;
    const terminal = ['completed', 'canceled', 'uncertain', 'failed-pre-submit'].includes(
      state.phase,
    );
    if (terminalSeen && !terminal) return;
    terminalSeen ||= terminal;
    const own = ++revision;
    const result = await api.conversations.messages({ id });
    if (own !== revision || settled) return;
    const messages = result.messages as unknown as ChatMessage[];
    const traceSummary = formatTraceSummary(state.trace);
    const draftContent = state.partial || traceSummary;
    onUpdate(
      state.phase === 'running' && draftContent
        ? [
            ...messages,
            {
              id: `draft_${token.attemptId}`,
              role: 'assistant',
              content:
                state.partial && traceSummary
                  ? `${state.partial}\n\n_${traceSummary}_`
                  : draftContent,
              timestamp: Date.now(),
            },
          ]
        : messages,
    );
    if (state.phase === 'completed' || state.phase === 'canceled') {
      settled = true;
      resolve();
    } else if (state.phase === 'uncertain' || state.phase === 'failed-pre-submit') {
      settled = true;
      reject(new Error(state.detail || state.phase));
    }
  };
  const update = (state: ManagedRuntimeState): void => {
    void accept(state).catch(reject);
  };
  const off = api.on('conversations.runtimeChanged', update);
  const cancel = (): void => {
    void api.conversations
      .runtimeCancel({ id, turnId, beforeGeneration: initial.generation })
      .then(update, reject);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(
    () => reject(new Error(t('ui.chat-settings.managed-observation-timeout'))),
    120_000,
  );
  try {
    token = await Promise.race([
      api.conversations.runtimeSend({
        id,
        messageId,
        turnId,
        text,
        expectedGeneration: initial.generation,
        ...(options?.images?.length ? { images: options.images } : {}),
        ...(options?.retry ? { retry: true } : {}),
      }),
      done.then((): never => {
        throw new Error(t('ui.chat-settings.managed-observation-timeout'));
      }),
    ]);
    const buffered = events;
    events = [];
    for (const event of buffered) update(event);
    if (signal?.aborted) cancel();
    // A slow reconciliation query must not hide an already observed terminal event.
    void api.conversations.runtimeState({ id }).then(update, reject);
    await done;
  } finally {
    settled = true;
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
    off();
  }
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
