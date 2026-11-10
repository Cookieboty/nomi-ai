import React from 'react';

import { ConversationView } from '../../src/components/Conversation';
import { nomiSlots } from '../../src/components/Conversation/nomiSlots';
import { MessageInput } from '../../src/components/MessageInput';
import { usePreviewChatWindow } from '../../src/components/PreviewChat/usePreviewChatWindow';
import {
  ChangesUiProvider,
  useChangesUi,
} from '../../src/components/SessionWorkspace/ChangesUiContext';
import {
  aiChatReducer,
  type AiChatActions,
  type AiChatState,
} from '../../src/contexts/AiChatContext';
import {
  AiChatStoreContext,
  createAiChatStore,
  useAiChatSelector,
} from '../../src/contexts/aiChatStore';
import { ResourceScopeProvider } from '../../src/contexts/ResourceContext';
import { useResourcePreview } from '../../src/hooks/useResourcePreview';
import { useSessionComposerDrafts } from '../../src/hooks/useSessionComposerDrafts';
import { ConversationStore } from '../../src/services/conversationStore';
import { MockIPCClient } from '../../src/services/IPCClient';
import { projectById } from '../../src/services/projects';
import { resourcePreviewClient } from '../../src/services/resourcePreviewClient';
import { nomiConvMessages } from '../../src/utils/convAdapters';

export function previewChatFixture(options?: { editable?: boolean }) {
  const conversations = new ConversationStore();
  const other = conversations.create({ name: '另一个会话', projectId: '/work/', backend: 'nomi' });
  conversations.append({ id: 'other-u', role: 'user', content: '另一份方案', timestamp: 1 });
  const source = conversations.create({
    name: '审查代码与预览文档',
    projectId: '/work',
    backend: 'nomi',
  });
  conversations.append({
    id: 'source-u',
    role: 'user',
    content: '检查文档与代码是否一致',
    timestamp: 10,
  });
  conversations.append({
    id: 'source-a',
    role: 'assistant',
    timestamp: 20,
    content:
      '已核对代码，支持 **Markdown**、表格与工具记录。\n\n| 项目 | 结果 |\n| --- | --- |\n| 接口 | 通过 |\n| 测试 | 通过 |\n\n```ts\nconst verified = true;\n```\n\n[打开设计文档](/work/design.md)',
    trace: [
      { type: 'thinking', text: '检查文件结构', at: 12 },
      {
        type: 'tool',
        name: 'read_file',
        id: 'read-1',
        status: 'start',
        input: JSON.stringify({ path: '/work/design.md' }),
        at: 14,
      },
      {
        type: 'tool',
        name: 'read_file',
        status: 'done',
        id: 'read-1',
        output: 'Document loaded',
        at: 16,
      },
    ],
  });
  class Client extends MockIPCClient {
    conversationStore = () => conversations;
    currentConversationId = () => conversations.currentId();
    ensureConversationId = () =>
      conversations.currentId() ?? conversations.create({ backend: 'nomi' }).id;
    listConversations = async () => conversations.list();
    switchConversation = async (id: string) => {
      conversations.switchTo(id);
    };
    getChatHistory = async () => conversations.getMessages(conversations.currentId() ?? '');
    saveMessage = async (message: AiChatState['messages'][number]) => {
      conversations.append(message);
    };
  }
  const ipc = new Client();
  const state = createAiChatStore({
    messages: conversations.getMessages(source.id),
    viewConvoId: source.id,
    ipcClient: ipc,
    isLoading: false,
    streaming: false,
    busyConvos: [],
    streamingConvos: [],
    config: {
      theme: 'dark',
      language: 'zh-CN',
      fontSize: 14,
      autoSave: true,
      maxHistoryLength: 1000,
    },
  });
  const loadChatHistory = async () =>
    state.set({
      ...state.get(),
      viewConvoId: conversations.currentId(),
      messages: await ipc.getChatHistory(),
    });
  const sent: Array<{ id?: string; text: string }> = [];
  const send = async (text: string) => {
    sent.push({ id: conversations.currentId(), text });
    conversations.append({
      id: `sent-${sent.length}`,
      role: 'user',
      content: text,
      timestamp: 100 + sent.length,
    });
    await loadChatHistory();
  };
  const actions = {
    loadChatHistory,
    sendStreamMessage: send,
    stopGeneration: () => undefined,
    askKnowledge: send,
    newConversation: async () => {
      conversations.create({ backend: 'nomi', projectId: '/work' });
      await loadChatHistory();
    },
  } as unknown as AiChatActions;
  const context = {
    store: state,
    dispatch: (action: Parameters<typeof aiChatReducer>[1]) =>
      state.set(aiChatReducer(state.get(), action)),
    actions,
  };
  const oldOpen = resourcePreviewClient.open;
  const oldSave = resourcePreviewClient.save;
  if (options?.editable)
    resourcePreviewClient.save = async () => ({ ok: true, revision: 'b'.repeat(64) });
  resourcePreviewClient.open = async (_, path) => ({
    ok: true,
    kind: 'markdown',
    path,
    ...(options?.editable
      ? { editable: true, url: '/__nomi/preview/fixture', revision: 'a'.repeat(64) }
      : {}),
    content:
      '# 设计文档\n\n此文档在切换会话时保持打开。\n\n| A | B |\n| --- | --- |\n| left cell | right cell |\n\n' +
      Array.from({ length: 24 }, (_, i) => `## 第 ${i + 1} 节\n\n这是预览文档正文。`).join('\n\n'),
  });
  function Probe() {
    const { composerFill } = useChangesUi();
    const current = useAiChatSelector((s) => s.viewConvoId);
    const messages = useAiChatSelector((s) => s.messages);
    const cwd = projectById(conversations.get(current ?? '')?.projectId)?.primary ?? null;
    const preview = useResourcePreview({ id: `nomi:${current ?? 'new'}`, cwd, source: 'nomi' });
    const chat = usePreviewChatWindow(
      preview.isOpen && preview.expanded,
      preview.connectConversation,
      preview.workspaceCwd,
    );
    const drafts = useSessionComposerDrafts();
    return (
      <ResourceScopeProvider value={preview.value}>
        <button
          data-testid="fixture-open"
          onClick={() => preview.value.open('/work/design.md', preview.value.scope)}
        >
          打开预览
        </button>
        <div
          className={`main-content ${preview.className}`}
          style={preview.style}
          data-testid="preview-chat-host"
        >
          <div
            className="chat-column"
            data-testid="chat-column"
            data-preview-chat-open={chat.expanded || undefined}
            data-preview-chat-min={chat.minimized || undefined}
            ref={chat.ref}
            style={chat.style}
            {...chat.events}
          >
            {chat.header}
            <main className="chat-container">
              <ConversationView
                scopeId={current ?? 'new'}
                messages={nomiConvMessages(messages)}
                phase="idle"
                slots={nomiSlots}
              />
            </main>
            <footer className="input-container" ref={preview.composerRef}>
              <MessageInput
                floating={preview.isOpen && preview.expanded}
                compact={preview.isOpen && preview.expanded}
                onSend={send}
                fill={composerFill}
                contextMessages={nomiConvMessages(messages)}
                disabled={preview.sendMismatch || chat.busy}
                draftStore={drafts.draftStore}
                draftKey={drafts.draftKey}
              />
            </footer>
          </div>
          {preview.panel}
        </div>
      </ResourceScopeProvider>
    );
  }
  return {
    source,
    other,
    conversations,
    state,
    sent,
    restore: () => {
      resourcePreviewClient.open = oldOpen;
      resourcePreviewClient.save = oldSave;
    },
    App: () => (
      <AiChatStoreContext.Provider value={context}>
        <ChangesUiProvider>
          <Probe />
        </ChangesUiProvider>
      </AiChatStoreContext.Provider>
    ),
  };
}
