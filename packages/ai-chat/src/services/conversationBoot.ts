/**
 * 会话存储的启动（对话窗口第一次渲染 App 之前，main.tsx；在这之前先显示启动画面，不会白屏）：
 * 1. 取内核的索引（`conversations.state`：元信息、预览、条数、当前会话），每次限时、失败重试几次；
 *    还是取不到就返回 `ok: false`：不迁移、不构造存储，启动画面显示错误与「重试」（不当作空列表，
 *    不然看起来像记录全丢了，之后的写入还可能盖掉指针）；
 * 2. 内核还没导入过（首次用新存储）：把本窗口 localStorage 里旧布局的会话一次性导入（conversationMigration，
 *    几个会话并行、进度报给启动画面），核对条数后记完成；旧键保留一个版本（降级还能看到），不删；
 * 3. Electron 旧对话（#181，`migration.chatHistory`）合并进同一份迁移来源一起导入，会话进了内核才记完成；
 * 4. 把索引交给之后构造的 ConversationStore（createConversationStore）。
 * 迁移没导完只记日志、照常渲染：下次启动再试（幂等，已有的 id 不覆盖）。
 */

import { createLogger } from '@nomi-ai/ui';

import {
  createContractConversationKernel,
  type ConversationKernel,
  type ConversationSnapshot,
} from './conversationKernel';
import {
  isLegacyConversationKey,
  migrateConversationsToKernel,
  type MigrationProgress,
} from './conversationMigration';
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

/** 每次取索引最多等这么久（传输卡住时不一直等） */
const STATE_TIMEOUT_MS = 5000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

async function stateWithRetry(
  kernel: ConversationKernel,
  opts: { tries?: number; timeoutMs?: number; backoffMs?: number } = {},
): Promise<ConversationSnapshot> {
  const tries = opts.tries ?? 3;
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await withTimeout(kernel.state(), opts.timeoutMs ?? STATE_TIMEOUT_MS);
    } catch (e) {
      last = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, (opts.backoffMs ?? 300) * (i + 1)));
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

export type BootResult =
  | {
      ok: true;
      snapshot: ConversationSnapshot;
      migration?: 'complete' | 'incomplete';
    }
  /** 内核的会话存储读不到：没迁移、没构造存储（启动画面显示错误，用户可重试） */
  | { ok: false; error: unknown };

export interface BootProgress {
  phase: 'migrating';
  done: number;
  total: number;
}

export async function prepareConversationStore(opts: {
  kernel?: ConversationKernel;
  api?: Parameters<typeof createContractConversationKernel>[0];
  /** 对话窗口的 localStorage（旧布局的来源；偏好与 Electron 导入标记也在这里） */
  storage?: BootStorage;
  /** Electron 旧对话（`migration.chatHistory`）；不给 = 不导 */
  fetchLegacy?: () => Promise<LegacyChatHistory>;
  /** 导入旧会话的进度（启动画面显示） */
  onProgress?: (p: BootProgress) => void;
  /** 测试用：取索引的限时与退避 */
  stateTimeoutMs?: number;
  stateBackoffMs?: number;
}): Promise<BootResult> {
  const kernel = opts.kernel ?? createContractConversationKernel(opts.api!);
  const retry = { timeoutMs: opts.stateTimeoutMs, backoffMs: opts.stateBackoffMs };
  let snapshot: ConversationSnapshot;
  try {
    snapshot = await stateWithRetry(kernel, retry);
  } catch (error) {
    // 读失败 ≠ 没有记录：不迁移、不构造存储（之前构造的也不动），交给启动画面提示重试
    log.error('conversation store unavailable', error);
    return { ok: false, error };
  }
  const storage = opts.storage;
  let migration: 'complete' | 'incomplete' | undefined;
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
        onProgress: (p: MigrationProgress) => opts.onProgress?.({ phase: 'migrating', ...p }),
      });
      snapshot = m.snapshot;
      migration = m.status;
      if (m.status === 'complete' && legacyPending) markLegacyImportDone(storage, legacyAdded);
      if (m.status === 'incomplete') {
        // 核对时没取到索引：再取一次，不拿导入前的旧索引渲染（导进去的会话会像丢了一样）
        try {
          snapshot = await stateWithRetry(kernel, retry);
        } catch (error) {
          log.error('conversation store unavailable after migration', error);
          return { ok: false, error };
        }
      }
    }
  }
  prepared = { kernel, snapshot };
  return { ok: true, snapshot, ...(migration ? { migration } : {}) };
}
