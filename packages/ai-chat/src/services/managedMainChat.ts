import type { AppClient } from '@nomi-ai/ai-sdk-client';
import { t } from '@nomi-ai/ui';

import type { ChatMessage } from '../types/chat';

type Port = Pick<AppClient, 'conversations' | 'on'>;
type State = Awaited<ReturnType<Port['conversations']['runtimeState']>>;
/** Reads only authoritative projection. Never upserts user/assistant view copies. */
export async function sendManagedConversation(
  api: Port,
  id: string,
  text: string,
  onUpdate: (messages: ChatMessage[]) => void,
  signal?: AbortSignal,
): Promise<void> {
  const initial = await api.conversations.runtimeState({ id });
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const messageId = `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const turnId = `turn_${messageId}`;
  let token: Awaited<ReturnType<Port['conversations']['runtimeSend']>> | undefined;
  let events: State[] = [];
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
  const accept = async (state: State): Promise<void> => {
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
    onUpdate(
      state.phase === 'running' && state.partial
        ? [
            ...messages,
            {
              id: `draft_${token.attemptId}`,
              role: 'assistant',
              content: state.partial,
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
  const update = (state: State): void => {
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
