// @vitest-environment happy-dom
import { ContractError } from '@nomi-ai/contract';
import { expect, it, vi } from 'vitest';

import { createMemoryConversationKernel } from '../src/services/conversationKernel';
import { ConversationStore } from '../src/services/conversationStore';
const original = { id: 'seed', role: 'user' as const, content: 'authoritative', timestamp: 1 };
async function fixture() {
  const kernel = createMemoryConversationKernel();
  await kernel.put({
    meta: { id: 'c', backend: 'nomi', name: 'same sidebar', createdAt: 1, updatedAt: 1 },
    messages: [original],
  });
  return { kernel, snapshot: await kernel.state() };
}
it('known managed view rejects writes before optimistic mutation or kernel upsert', async () => {
  const { kernel, snapshot } = await fixture();
  const store = new ConversationStore({ kernel, snapshot: { ...snapshot, managed: ['c'] } });
  try {
    for (const mutate of [
      () => store.append({ ...original, id: 'ghost' }, 'c'),
      () => store.setMessages('c', []),
      () => store.updateMeta('c', { name: 'wrong' }),
    ])
      expect(mutate).toThrow();
    expect(store.get('c')?.name).toBe('same sidebar');
    expect(await store.loadMessages('c')).toEqual([original]);
    expect(kernel.data.messages.get('c')).toEqual([original]);
  } finally {
    store.dispose();
  }
});
it('stale window ownership rejection drops optimistic ghost, marks managed and refreshes projection', async () => {
  const { kernel, snapshot } = await fixture();
  const state = kernel.state.bind(kernel);
  kernel.state = async () => ({ ...(await state()), managed: ['c'] });
  kernel.failNext = (name) =>
    name === 'append' ? new ContractError('CONVERSATION_MANAGED', 'runtime owns chat') : false;
  const store = new ConversationStore({ kernel, snapshot, retryDelays: [] });
  try {
    store.append({ ...original, id: 'ghost', content: 'never authoritative' }, 'c');
    await store.flush();
    await vi.waitFor(() => expect(store.isManaged('c')).toBe(true));
    await vi.waitFor(async () => expect(await store.loadMessages('c')).toEqual([original]));
    expect(store.hasPendingWrites()).toBe(false);
    expect(kernel.calls.filter((name) => name === 'append')).toHaveLength(1);
  } finally {
    store.dispose();
  }
});
it('busy managed delete is not retried after work finishes and sidebar ownership is restored', async () => {
  const { kernel, snapshot } = await fixture();
  let attempts = 0;
  kernel.remove = async () => {
    attempts++;
    throw new ContractError('RUNTIME_BUSY', 'active work');
  };
  const store = new ConversationStore({
    kernel,
    snapshot: { ...snapshot, managed: ['c'] },
    retryDelays: [],
  });
  try {
    store.delete('c');
    await store.flush();
    await vi.waitFor(() => expect(store.get('c')?.name).toBe('same sidebar'));
    expect(attempts).toBe(1);
    expect(store.hasPendingWrites()).toBe(false);
    expect(kernel.data.messages.get('c')).toEqual([original]);
  } finally {
    store.dispose();
  }
});
