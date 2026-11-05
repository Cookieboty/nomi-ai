/**
 * 会话存储的启动（对话窗口第一次渲染之前，main.tsx）：
 * 1. 取内核的索引（`conversations.state`：元信息、预览、条数、当前会话），失败时重试几次；
 * 2. 内核还没导入过（首次用新存储）：把本窗口 localStorage 里旧布局的会话一次性导入（conversationMigration），
 *    核对条数后记完成；旧键保留一个版本（降级还能看到），不删；
 * 3. Electron 旧对话（#181，`migration.chatHistory`）合并进同一份迁移来源一起导入，会话进了内核才记完成；
 * 4. 把索引交给之后构造的 ConversationStore（createConversationStore）。
 * 每一步失败都只记日志、照常渲染：迁移下次启动再试（幂等，已有的 id 不覆盖）。
 */

import { createLogger } from '@nomi-ai/ui';

import {
  createContractConversationKernel,
  type ConversationKernel,
  type ConversationSnapshot,
} from './conversationKernel';
import { isLegacyConversationKey, migrateConversationsToKernel } from './conversationMigration';
import {
  ConversationStore,
  createMemoryStorage,
  type ConversationStoreOptions,
  type KeyValueStorage,
} from './conversationStore';
import {
  LEGACY_IMPORT_MARKER,
  markLegacyImportDone,
  runLegacyChatImport,
  type LegacyChatHistory,
} from './legacyChatImport';

const log = createLogger('conversationBoot');

type BootStorage = KeyValueStorage & { readonly length: number; key(i: number): string | null };

let prepared: { kernel: ConversationKernel; snapshot: ConversationSnapshot } | undefined;

/** 构造会话存储：启动时准备好了就接内核，否则（测试 / 浏览器预览）只在内存里 */
export function createConversationStore(
  opts: Omit<ConversationStoreOptions, 'kernel' | 'snapshot'> = {},
): ConversationStore {
  if (!prepared) return new ConversationStore(opts);
  // 每个存储一份自己的快照（StrictMode 下 reducer 初始化会跑两次）
  const snapshot = JSON.parse(JSON.stringify(prepared.snapshot)) as ConversationSnapshot;
  return new ConversationStore({ ...opts, kernel: prepared.kernel, snapshot });
}

/** 测试用 */
export function resetPreparedConversationStore(): void {
  prepared = undefined;
}

const EMPTY: ConversationSnapshot = {
  conversations: [],
  previews: {},
  counts: {},
  migrated: false,
};

async function stateWithRetry(
  kernel: ConversationKernel,
  tries = 3,
): Promise<ConversationSnapshot> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await kernel.state();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 200 * (i + 1)));
    }
  }
  throw last;
}

/** 旧布局的会话键复制一份到内存（合并 Electron 旧对话时不受 localStorage 配额限制，也不改原键） */
function copyConversationKeys(storage: BootStorage): BootStorage {
  const out = createMemoryStorage();
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (!k || !isLegacyConversationKey(k)) continue;
      const v = storage.getItem(k);
      if (v !== null) out.setItem(k, v);
    }
  } catch (e) {
    log.warn('reading old conversations failed', e);
  }
  return out;
}

export interface BootResult {
  snapshot: ConversationSnapshot;
  migration?: 'complete' | 'incomplete' | 'skipped';
}

export async function prepareConversationStore(opts: {
  kernel?: ConversationKernel;
  api?: Parameters<typeof createContractConversationKernel>[0];
  /** 对话窗口的 localStorage（旧布局的来源；偏好与 Electron 导入标记也在这里） */
  storage?: BootStorage;
  /** Electron 旧对话（`migration.chatHistory`）；不给 = 不导 */
  fetchLegacy?: () => Promise<LegacyChatHistory>;
}): Promise<BootResult> {
  const kernel = opts.kernel ?? createContractConversationKernel(opts.api!);
  let snapshot: ConversationSnapshot;
  try {
    snapshot = await stateWithRetry(kernel);
  } catch (e) {
    // 内核的会话存储读不到：这次不迁移（不记完成），新写的照样进内核
    log.error('conversation store unavailable', e);
    prepared = { kernel, snapshot: EMPTY };
    return { snapshot: EMPTY, migration: 'skipped' };
  }
  const storage = opts.storage;
  let migration: BootResult['migration'];
  if (storage) {
    const source: BootStorage = snapshot.migrated
      ? createMemoryStorage()
      : copyConversationKeys(storage);
    let legacyAdded = 0;
    let legacyPending = false;
    let hasMarker = false;
    try {
      hasMarker = storage.getItem(LEGACY_IMPORT_MARKER) !== null;
    } catch {
      /* */
    }
    if (opts.fetchLegacy && !hasMarker) {
      const r = await runLegacyChatImport({
        fetch: opts.fetchLegacy,
        storage: source,
        prefs: storage,
        marker: storage,
        deferMark: true,
      }).catch((e: unknown) => {
        log.warn('legacy chat import failed', e);
        return undefined;
      });
      if (r?.status === 'imported') {
        legacyPending = true;
        legacyAdded = r.conversations;
      }
    }
    if (!snapshot.migrated || legacyPending) {
      const m = await migrateConversationsToKernel({
        kernel,
        source,
        snapshot,
        mark: !snapshot.migrated,
      });
      snapshot = m.snapshot;
      migration = m.status;
      if (m.status === 'complete' && legacyPending) markLegacyImportDone(storage, legacyAdded);
    }
  }
  prepared = { kernel, snapshot };
  return { snapshot, ...(migration ? { migration } : {}) };
}
