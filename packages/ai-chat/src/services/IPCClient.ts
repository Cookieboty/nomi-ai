import { ClientAIClient } from '@nomi-ai/ai-sdk-client';
import { t } from '@nomi-ai/ui';
import { createLogger } from '@nomi-ai/ui';

import {
  type ChatMessage,
  type ChatConfig,
  type ChatSession,
  type ConversationBackend,
} from '../types/chat';
import { type IPCClient, type ElectronAPI, type StreamSendOptions } from '../types/ipc';
import { chunkToTrace, chunkToUsage } from '../utils/chunkTrace';

import { ConversationStore } from './conversationStore';
import { buildProviderMessages } from './history';
import { upstreamErrorText } from './upstreamErrorText';

const log = createLogger('IPC');

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
    aiIPC?: unknown;
  }
}

const LOCAL_CONFIG_KEY = 'ai-chat:config';

type SdkChatFacade = {
  sendMessage: (opts: SdkChatOptions) => Promise<{ content?: string } & Record<string, unknown>>;
  stream: (opts: SdkChatOptions) => AsyncIterable<SdkChatChunk>;
  /** 工具循环（桌面文件工具 / 看板娘工具）；旧主进程没有该通道时退回 stream */
  agentStream?: (opts: SdkChatOptions & { role?: string }) => AsyncIterable<SdkChatChunk>;
  abort: (reqId: string) => void;
};

interface SdkChatOptions {
  reqId?: string;
  provider?: string;
  model?: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string }>;
}

type SdkChatChunk =
  | { type: 'delta'; content: string }
  | { type: 'done'; finishReason?: string }
  | { type: 'error'; error: string }
  | { type: string; [k: string]: unknown };

type SdkUserProfileFacade = {
  get: () => Record<string, unknown> | undefined;
  set: (input: { patch: Record<string, unknown>; source?: string }) => Promise<unknown>;
};

const readStorage = <T>(key: string): T | undefined => {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return undefined;
    const raw = window.localStorage.getItem(key);
    if (!raw) return undefined;
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
};

const writeStorage = (key: string, value: unknown): void => {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
};

const DEFAULT_CONFIG: ChatConfig = {
  theme: 'light',
  language: 'zh-CN',
  fontSize: 14,
  autoSave: true,
  maxHistoryLength: 1000,
  systemPrompt: 'ui.chat-settings.you-are-nomi-an-ai-companion-who-lives',
};

export class SdkIPCClient implements IPCClient {
  private readonly client: ClientAIClient;
  private readonly owned: boolean;
  private readonly store = new ConversationStore();

  constructor(client?: ClientAIClient) {
    if (client) {
      this.client = client;
      this.owned = false;
    } else {
      this.client = new ClientAIClient();
      this.owned = true;
    }
  }

  async dispose(): Promise<void> {
    if (this.owned) await this.client.dispose();
  }

  private get chat(): SdkChatFacade {
    return this.client.chat as unknown as SdkChatFacade;
  }

  private get userProfile(): SdkUserProfileFacade {
    return this.client.memory.userProfile as unknown as SdkUserProfileFacade;
  }

  private async buildMessages(
    message: string,
    history: ChatMessage[] = [],
    extra?: string,
    images?: Array<{ mime: string; data: string }>,
  ) {
    const { systemPrompt } = await this.getConfig();
    const sys = [systemPrompt, extra].filter((s) => s && s.trim()).join('\n\n');
    return buildProviderMessages(history, message, sys, images);
  }

  currentConversationId(): string | undefined {
    try {
      return this.store.currentId();
    } catch {
      return undefined;
    }
  }

  async sendMessage(
    message: string,
    history?: ChatMessage[],
    extraSystem?: string,
  ): Promise<string> {
    try {
      const resp = await this.chat.sendMessage({
        messages: await this.buildMessages(message, history, extraSystem),
      });
      return typeof resp?.content === 'string' ? resp.content : '';
    } catch (error) {
      throw Object.assign(
        new Error(
          t('ui.chat-settings.failed-to-send-message', (error as Error).message ?? String(error)),
        ),
        {
          cause: error,
        },
      );
    }
  }

  async sendStreamMessage(
    message: string,
    onChunk?: (chunk: string) => void,
    history?: ChatMessage[],
    extraSystem?: string,
    images?: Array<{ mime: string; data: string }>,
    streamOpts?: StreamSendOptions,
  ): Promise<void> {
    const reqId = streamOpts?.reqId;
    const signal = streamOpts?.signal;
    try {
      const opts = {
        messages: await this.buildMessages(message, history, extraSystem, images),
        ...(reqId ? { reqId } : {}),
      };
      if (signal?.aborted) return;
      // 对话走工具循环（role 仍是 chat，按 chat 路由选 provider）
      const iterable =
        typeof this.chat.agentStream === 'function'
          ? this.chat.agentStream({ ...opts, role: 'chat' })
          : this.chat.stream(opts);
      const it = iterable[Symbol.asyncIterator]();
      // 中止：通知主进程中止上游请求，同时让本地循环立即退出（不依赖上游及时收尾）
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<'aborted'>((resolve) => {
        onAbort = () => {
          if (reqId) this.abortStream(reqId);
          resolve('aborted');
        };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        for (;;) {
          const r = await Promise.race([it.next(), aborted]);
          if (r === 'aborted' || signal?.aborted) break;
          if (r.done) break;
          const chunk = r.value;
          if (!chunk || typeof chunk !== 'object') continue;
          const c = chunk as SdkChatChunk;
          if (c.type === 'delta' && typeof (c as { content?: string }).content === 'string') {
            onChunk?.((c as { content: string }).content);
          } else if (c.type === 'error') {
            throw new Error((c as { error: string }).error);
          } else if (streamOpts?.onTrace || streamOpts?.onUsage) {
            const ev = chunkToTrace(c);
            if (ev) streamOpts.onTrace?.(ev);
            const u = chunkToUsage(c);
            if (u) streamOpts.onUsage?.(u);
          }
        }
      } catch (error) {
        // 主动中止时上游常以 abort 错误收尾：不是失败
        if (!signal?.aborted) throw error;
      } finally {
        if (onAbort) signal?.removeEventListener('abort', onAbort);
        // 通知迭代器清理（ClientAIClient.return 会再发一次 ai:chat:abort 并退订 chunk）
        void Promise.resolve(it.return?.()).catch(() => undefined);
      }
    } catch (error) {
      const msg = (error as Error).message ?? String(error);
      throw Object.assign(
        new Error(
          upstreamErrorText(msg) ?? t('ui.chat-settings.failed-to-send-streaming-message', msg),
        ),
        {
          cause: error,
        },
      );
    }
  }

  abortStream(reqId: string): void {
    try {
      this.chat.abort(reqId);
    } catch (e) {
      log.warn('abort failed', e);
    }
  }

  async getChatHistory(): Promise<ChatMessage[]> {
    return this.store.getMessages();
  }

  async clearChatHistory(): Promise<void> {
    this.store.clear();
  }

  async saveMessage(message: ChatMessage): Promise<void> {
    this.store.maxMessages = (await this.getConfig()).maxHistoryLength;
    this.store.append(message, this.store.nomiTarget());
  }

  async saveMessageTo(message: ChatMessage, conversationId: string): Promise<void> {
    this.store.maxMessages = (await this.getConfig()).maxHistoryLength;
    // 会话在流式期间被删除：不要复活它，也不要把消息写进别的会话
    if (!this.store.get(conversationId)) return;
    // CLI 标签的镜像项只存元信息，消息在 harness 里：Nomi 轮次不能写进去（#19）
    if (!this.store.isNomi(conversationId)) {
      log.warn('refusing to save a Nomi message into a non-Nomi conversation', conversationId);
      return;
    }
    this.store.append(message, conversationId);
  }

  ensureConversationId(): string {
    return this.store.nomiTarget();
  }

  async listConversations(): Promise<Array<Omit<ChatSession, 'messages'>>> {
    return this.store.list();
  }

  async newConversation(
    name?: string,
    opts?: { backend?: ConversationBackend; tabId?: string },
  ): Promise<string> {
    return this.store.create({ name, backend: opts?.backend, tabId: opts?.tabId }).id;
  }

  async switchConversation(id: string): Promise<void> {
    this.store.switchTo(id);
  }

  async updateConversation(
    id: string,
    patch: Partial<Pick<ChatSession, 'name' | 'backend' | 'tabId' | 'cliSessionId' | 'updatedAt'>>,
  ) {
    return this.store.updateMeta(id, patch);
  }

  async forkConversation(
    id: string,
    opts?: {
      backend?: ConversationBackend;
      tabId?: string;
      name?: string;
      messages?: ChatMessage[];
    },
  ) {
    return this.store.fork(id, opts);
  }

  async deleteConversation(id: string): Promise<void> {
    this.store.delete(id);
  }

  conversationStore() {
    return this.store;
  }

  async getConfig(): Promise<ChatConfig> {
    const local = readStorage<ChatConfig>(LOCAL_CONFIG_KEY);
    if (local) return { ...DEFAULT_CONFIG, ...local };
    try {
      const profile = this.userProfile.get();
      const chatCfg = (profile as { chat?: Partial<ChatConfig> } | undefined)?.chat;
      if (chatCfg) return { ...DEFAULT_CONFIG, ...chatCfg };
    } catch {
      /* ignore */
    }
    return { ...DEFAULT_CONFIG };
  }

  async updateConfig(config: Partial<ChatConfig>): Promise<void> {
    const current = await this.getConfig();
    const merged = { ...current, ...config };
    writeStorage(LOCAL_CONFIG_KEY, merged);
    try {
      await this.userProfile.set({
        patch: { chat: merged } as unknown as Record<string, unknown>,
        source: 'user',
      });
    } catch {
      /* profile may not accept `chat` field yet — 本地缓存已保存，允许失败 */
    }
  }
}

export class MockIPCClient implements IPCClient {
  private history: ChatMessage[] = [
    { id: '1', role: 'user', content: t('ui.chat-settings.hello'), timestamp: Date.now() - 60000 },
    {
      id: '2',
      role: 'assistant',
      content: t('ui.chat-settings.hello-how-can-i-help-you'),
      timestamp: Date.now() - 50000,
    },
  ];
  private config: ChatConfig = { ...DEFAULT_CONFIG };

  async sendMessage(message: string, history?: ChatMessage[]): Promise<string> {
    log.info('[Mock] Send message:', message, 'history:', history?.length ?? 0);
    await new Promise((r) => setTimeout(r, 500));
    return t('ui.chat-settings.mock-reply', message);
  }

  async sendStreamMessage(message: string, onChunk?: (chunk: string) => void): Promise<void> {
    const chunks = [
      t('ui.chat-settings.mock'),
      t('ui.chat-settings.streaming'),
      t('ui.chat-settings.reply'),
      t('ui.chat-settings.content'),
    ];
    for (const c of chunks) {
      await new Promise((r) => setTimeout(r, 200));
      onChunk?.(c + ' ');
    }
  }

  async getChatHistory(): Promise<ChatMessage[]> {
    return [...this.history];
  }

  async clearChatHistory(): Promise<void> {
    this.history = [];
  }

  async saveMessage(message: ChatMessage): Promise<void> {
    this.history.push(message);
  }

  async listConversations(): Promise<Array<Omit<ChatSession, 'messages'>>> {
    return [
      {
        id: 'mock',
        name: t('ui.chat-settings.mock-conversation'),
        createdAt: 0,
        updatedAt: 0,
        backend: 'nomi',
      },
    ];
  }

  async newConversation(): Promise<string> {
    this.history = [];
    return 'mock';
  }

  async switchConversation(): Promise<void> {
    /* mock 只有一个会话 */
  }

  async getConfig(): Promise<ChatConfig> {
    return { ...this.config };
  }

  async updateConfig(config: Partial<ChatConfig>): Promise<void> {
    this.config = { ...this.config, ...config };
  }
}

export const createIPCClient = (client?: ClientAIClient): IPCClient => {
  if (client) return new SdkIPCClient(client);
  if (typeof window !== 'undefined' && (window as { aiIPC?: unknown }).aiIPC) {
    return new SdkIPCClient();
  }
  log.warn('window.aiIPC 未就绪，使用 Mock 客户端（开发/测试模式）');
  return new MockIPCClient();
};
