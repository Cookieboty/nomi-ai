import { ClientAIClient } from '@nomi-ai/ai-sdk-client';
import { t } from '@nomi-ai/ui';
import { createLogger } from '@nomi-ai/ui';

import {
  type ChatMessage,
  type ChatConfig,
  type ChatSession,
  type ConversationBackend,
} from '../types/chat';
import { type AIModelConfig } from '../types/config';
import { type IPCClient, type ElectronAPI, type StreamSendOptions } from '../types/ipc';
import { chunkToTrace, chunkToUsage } from '../utils/chunkTrace';

import { ConversationStore } from './conversationStore';
import { buildProviderMessages } from './history';
import { providerClientAvailable } from './providerClient';

const log = createLogger('IPC');

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
    aiIPC?: unknown;
  }
}

const LOCAL_CONFIG_KEY = 'ai-chat:config';
const LOCAL_MODELS_KEY = 'ai-chat:models';
const LOCAL_CURRENT_MODEL_KEY = 'ai-chat:currentModel';

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
  systemPrompt:
    '你是 Nomi（诺米），住在用户桌面上的 AI 伙伴，运行在用户自己的电脑上。语气温暖、专业、可信赖：先给结论，再给步骤；不确定时坦诚说明。请结合之前的对话内容，简洁、准确地回答。',
};

const DEFAULT_MODELS: AIModelConfig[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek Chat',
    provider: 'deepseek',
    apiUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    enabled: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    provider: 'openai',
    apiUrl: 'https://api.openai.com',
    model: 'gpt-4o-mini',
    enabled: true,
  },
  {
    id: 'claude',
    name: 'Claude',
    provider: 'claude',
    apiUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-5',
    enabled: true,
  },
  {
    id: 'gemini',
    name: 'Gemini',
    provider: 'gemini',
    apiUrl: 'https://generativelanguage.googleapis.com',
    model: 'gemini-2.5-flash',
    enabled: true,
  },
  {
    id: 'ollama',
    name: 'Ollama',
    provider: 'ollama',
    apiUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:3b-instruct',
    enabled: true,
    isLocal: true,
  },
];

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

  /**
   * 主进程提供多 provider 配置（`ai:providers:*`）时，provider 由主进程路由
   * （当前 provider / 任务路由 / 环境变量回退），渲染层不再指定。
   */
  private currentModelId(fallback?: string): string | undefined {
    if (providerClientAvailable()) return undefined;
    return fallback ?? readStorage<string>(LOCAL_CURRENT_MODEL_KEY);
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
    modelId?: string,
    history?: ChatMessage[],
    extraSystem?: string,
  ): Promise<string> {
    try {
      const resp = await this.chat.sendMessage({
        provider: this.currentModelId(modelId),
        messages: await this.buildMessages(message, history, extraSystem),
      });
      return typeof resp?.content === 'string' ? resp.content : '';
    } catch (error) {
      throw Object.assign(
        new Error(t('发送消息失败: {0}', (error as Error).message ?? String(error))),
        {
          cause: error,
        },
      );
    }
  }

  async sendStreamMessage(
    message: string,
    modelId?: string,
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
        provider: this.currentModelId(modelId),
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
      throw Object.assign(
        new Error(t('发送流式消息失败: {0}', (error as Error).message ?? String(error))),
        { cause: error },
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
    this.store.append(message, this.store.ensureCurrent());
  }

  async saveMessageTo(message: ChatMessage, conversationId: string): Promise<void> {
    this.store.maxMessages = (await this.getConfig()).maxHistoryLength;
    // 会话在流式期间被删除：不要复活它，也不要把消息写进别的会话
    if (!this.store.get(conversationId)) return;
    this.store.append(message, conversationId);
  }

  ensureConversationId(): string {
    return this.store.ensureCurrent();
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
    patch: Partial<Pick<ChatSession, 'name' | 'backend' | 'tabId' | 'updatedAt'>>,
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

  async getAvailableModels(): Promise<AIModelConfig[]> {
    const list = readStorage<AIModelConfig[]>(LOCAL_MODELS_KEY);
    if (list && list.length > 0) return list;
    writeStorage(LOCAL_MODELS_KEY, DEFAULT_MODELS);
    return [...DEFAULT_MODELS];
  }

  async addModel(model: AIModelConfig): Promise<void> {
    const list = await this.getAvailableModels();
    const next = list.filter((m) => m.id !== model.id).concat(model);
    writeStorage(LOCAL_MODELS_KEY, next);
  }

  async removeModel(modelId: string): Promise<void> {
    const list = await this.getAvailableModels();
    writeStorage(
      LOCAL_MODELS_KEY,
      list.filter((m) => m.id !== modelId),
    );
  }

  async updateModel(modelId: string, updates: Partial<AIModelConfig>): Promise<void> {
    const list = await this.getAvailableModels();
    const next = list.map((m) => (m.id === modelId ? { ...m, ...updates } : m));
    writeStorage(LOCAL_MODELS_KEY, next);
  }

  async testModelConnection(modelId: string): Promise<boolean> {
    try {
      await this.chat.sendMessage({
        provider: modelId,
        messages: [{ role: 'user', content: 'ping' }],
      });
      return true;
    } catch {
      return false;
    }
  }
}

export class MockIPCClient implements IPCClient {
  private history: ChatMessage[] = [
    { id: '1', role: 'user', content: t('你好'), timestamp: Date.now() - 60000 },
    {
      id: '2',
      role: 'assistant',
      content: t('你好！有什么可以帮助你的吗？'),
      timestamp: Date.now() - 50000,
    },
  ];
  private config: ChatConfig = { ...DEFAULT_CONFIG };
  private models: AIModelConfig[] = [...DEFAULT_MODELS];

  async sendMessage(message: string, modelId?: string, history?: ChatMessage[]): Promise<string> {
    log.info(
      '[Mock] Send message:',
      message,
      'to model:',
      modelId,
      'history:',
      history?.length ?? 0,
    );
    await new Promise((r) => setTimeout(r, 500));
    return t('模拟回复: {0}', message);
  }

  async sendStreamMessage(
    message: string,
    _modelId?: string,
    onChunk?: (chunk: string) => void,
  ): Promise<void> {
    const chunks = [t('模拟'), t('流式'), t('回复'), t('内容')];
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
    return [{ id: 'mock', name: t('Mock 对话'), createdAt: 0, updatedAt: 0, backend: 'nomi' }];
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

  async getAvailableModels(): Promise<AIModelConfig[]> {
    return [...this.models];
  }

  async addModel(model: AIModelConfig): Promise<void> {
    this.models = this.models.filter((m) => m.id !== model.id).concat(model);
  }

  async removeModel(modelId: string): Promise<void> {
    this.models = this.models.filter((m) => m.id !== modelId);
  }

  async updateModel(modelId: string, updates: Partial<AIModelConfig>): Promise<void> {
    this.models = this.models.map((m) => (m.id === modelId ? { ...m, ...updates } : m));
  }

  async testModelConnection(modelId: string): Promise<boolean> {
    log.info('[Mock] Test model connection:', modelId);
    return true;
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
