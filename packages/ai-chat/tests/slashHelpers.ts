import { vi } from 'vitest';

import type {
  BackendModelCatalog,
  SlashDiscoveryEntry,
  TabSource,
} from '../src/services/harnessClient';
import { adapterFor, scopeOrderFor } from '../src/slash/adapters';
import { buildRegistry } from '../src/slash/registry';
import type { SlashContext, SlashData } from '../src/slash/types';
import type { ConversationBackend } from '../src/types/chat';
import type { ConvMessage } from '../src/types/conversation';

export const emptyData = (): SlashData => ({
  cli: null,
  usage: null,
  quota: null,
  cliAccount: null,
  cliTab: null,
  nomiProviders: null,
  nomiGateway: null,
});

export function entry(p: Partial<SlashDiscoveryEntry> & { name: string }): SlashDiscoveryEntry {
  return {
    id: `project:command::${p.name}`,
    kind: 'command',
    scope: 'project',
    description: '',
    userInvocable: true,
    where: `.claude/commands/${p.name}.md`,
    ...p,
  };
}

export const asst = (id: string, text: string, usage?: ConvMessage['usage']): ConvMessage => ({
  id,
  role: 'assistant',
  text,
  at: 1,
  ...(usage ? { usage } : {}),
});
export const user = (id: string, text: string): ConvMessage => ({ id, role: 'user', text, at: 1 });

export function makeCtx(
  backend: ConversationBackend,
  over: Partial<SlashContext> & {
    data?: Partial<SlashData>;
    discovered?: SlashDiscoveryEntry[];
  } = {},
) {
  const actions = {
    newSession: vi.fn(),
    openPlugins: vi.fn(),
    openProviders: vi.fn(),
    openSettings: vi.fn(),
    // 默认没有可打开的模型浮层：/model 退回卡片
    openModelMenu: vi.fn((_query: string) => false),
    switchNomiModel: vi.fn(async () => undefined),
    setTabSource: vi.fn(async (_source: TabSource, _model?: string) => true),
    tabModels: vi.fn(async () => ({
      catalog: null as BackendModelCatalog | null,
      current: null as string | null,
      source: 'official' as TabSource,
      lastServedRef: undefined as string | undefined,
    })),
    setTabModel: vi.fn(async () => undefined),
    gitDiff: vi.fn(async () => ({ ok: true, status: '', stat: '', diff: '', truncated: false })),
    expand: vi.fn(async () => null as { text: string; shellInjection: boolean } | null),
    nomiSkillBody: vi.fn(async () => null as string | null),
    sendPlain: vi.fn(),
    compactNomi: vi.fn(
      async () =>
        ({ status: 'done' }) as { status: 'done' | 'nothing' | 'busy' | 'failed'; error?: string },
    ),
  };
  const commands = buildRegistry(
    adapterFor(backend, { backend, discovered: over.discovered ?? null }),
    scopeOrderFor(backend),
  );
  const ctx: SlashContext = {
    backend,
    cwd: '/work/app',
    messages: [],
    session: backend === 'nomi' ? null : { id: 'abcdef123456', running: false },
    commands: () => commands,
    load: async () => ({ ...emptyData(), ...over.data }),
    actions,
    ...(over.messages ? { messages: over.messages } : {}),
  };
  return { ctx, actions, commands };
}
