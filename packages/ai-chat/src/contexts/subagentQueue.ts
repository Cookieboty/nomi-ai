/**
 * 子任务面板的待发消息（#281）：按子任务标签 id 分区，放在面板外，切换 / 关掉面板都不串、不丢。
 * - 每条带目标标签与代次（标签关掉后再出现同 id 也不认旧的）；入队、插话返回、发送结果、出错恢复都先核对身份；
 * - 插话（steer）返回前占着位置，返回 false / 出错只回到原标签的队列，true 就此结束、不再发送；
 * - 每个标签同一时间只发一条：等 sendTab 结束再发下一条；没被接收的留在队首、队列暂停（不自动重试），
 *   用户再发一条或这个标签跑完一轮后接着发；被接收后才失败的（消息已进历史）不重发。
 * 面板只是展示当前标签的那一份。
 */
import { createLogger } from '@nomi-ai/ui';

const log = createLogger('subagent-queue');

export type SubagentItemState = 'steering' | 'queued' | 'sending' | 'failed';

export interface SubagentQueueItem {
  id: string;
  tabId: string;
  /** 标签代次：标签被移除时加一，之前的异步结果一律作废 */
  gen: number;
  text: string;
  state: SubagentItemState;
}

export interface SubagentTabView {
  draft: string;
  /** 还在排队的（含发送失败等你处理的）；在插话 / 正在发的不显示 */
  queued: readonly string[];
  error: string | null;
}

export interface SubagentQueueDeps {
  send: (tabId: string, text: string) => Promise<unknown>;
  steer: (tabId: string, text: string) => Promise<boolean>;
  /** sendTab 出错后核对：这条是否已被内核接收（已写进历史），接收了就不再重发 */
  accepted: (tabId: string, text: string, since: number) => Promise<boolean>;
  now?: () => number;
}

export interface SubagentQueue {
  view(tabId: string): SubagentTabView;
  subscribe(listener: () => void): () => void;
  setDraft(tabId: string, draft: string): void;
  /** 发送输入框里的内容（清空草稿）：运行中先试插话，否则进队列按顺序发 */
  submit(tabId: string): Promise<void>;
  removeQueued(tabId: string, index: number): void;
  /** 标签状态（来自标签列表）：标签没了就丢掉它的队列；跑完一轮就接着发 */
  sync(tabs: readonly { id: string; status: string }[]): void;
}

interface Slot {
  gen: number;
  draft: string;
  error: string | null;
  items: SubagentQueueItem[];
  /** 队首发送失败：等用户再发一条或这个标签跑完一轮 */
  paused: boolean;
  /** 有一条正在 sendTab */
  inflight: boolean;
  view: SubagentTabView;
}

const EMPTY_VIEW: SubagentTabView = { draft: '', queued: [], error: null };
const isRunning = (status: string) => status === 'running' || status === 'queued';

export function createSubagentQueue(deps: SubagentQueueDeps): SubagentQueue {
  const now = deps.now ?? Date.now;
  const slots = new Map<string, Slot>();
  /** 每个标签的代次：标签移除后保留，同 id 再出现时从更大的代次开始 */
  const gens = new Map<string, number>();
  /** 最近一次标签列表里的运行状态；undefined = 还没见过 */
  const running = new Map<string, boolean>();
  const listeners = new Set<() => void>();
  let seq = 0;

  const emit = () => {
    for (const l of [...listeners]) l();
  };

  const refresh = (s: Slot) => {
    s.view = {
      draft: s.draft,
      queued: s.items
        .filter((i) => i.state === 'queued' || i.state === 'failed')
        .map((i) => i.text),
      error: s.error,
    };
  };

  const slotOf = (tabId: string): Slot => {
    let s = slots.get(tabId);
    if (!s) {
      s = {
        gen: gens.get(tabId) ?? 0,
        draft: '',
        error: null,
        items: [],
        paused: false,
        inflight: false,
        view: EMPTY_VIEW,
      };
      slots.set(tabId, s);
    }
    return s;
  };

  /** 这一条还属于它的标签（标签没被移除、代次一致、还在队列里） */
  const owner = (item: SubagentQueueItem): Slot | null => {
    const s = slots.get(item.tabId);
    return s && s.gen === item.gen && s.items.includes(item) ? s : null;
  };

  const resume = (s: Slot) => {
    s.paused = false;
    for (const i of s.items) if (i.state === 'failed') i.state = 'queued';
  };

  /** 标签空闲、没有正在发的、没暂停时发队首；队首还在插话就等它返回 */
  const pump = (tabId: string) => {
    const s = slots.get(tabId);
    if (!s || s.paused || s.inflight || running.get(tabId) !== false) return;
    const head = s.items[0];
    if (!head || head.state !== 'queued') return;
    head.state = 'sending';
    s.inflight = true;
    s.error = null;
    refresh(s);
    const since = now();
    void deps
      .send(tabId, head.text)
      .then(
        () => true,
        async (e: unknown) => {
          const ok = await deps.accepted(tabId, head.text, since).catch(() => false);
          const own = owner(head);
          if (own) own.error = e instanceof Error ? e.message : String(e);
          return ok;
        },
      )
      .then((ok) => {
        const own = owner(head);
        if (!own) return;
        own.inflight = false;
        if (ok) own.items = own.items.filter((i) => i !== head);
        else {
          head.state = 'failed';
          own.paused = true;
        }
        refresh(own);
        pump(tabId);
        emit();
      });
    emit();
  };

  return {
    view: (tabId) => slots.get(tabId)?.view ?? EMPTY_VIEW,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setDraft(tabId, draft) {
      const s = slotOf(tabId);
      if (s.draft === draft) return;
      s.draft = draft;
      refresh(s);
      emit();
    },
    async submit(tabId) {
      const s = slotOf(tabId);
      const text = s.draft.trim();
      if (!text) return;
      s.draft = '';
      s.error = null;
      // 用户又发了一条：之前没发出去的跟着按顺序重试
      if (s.paused) resume(s);
      const item: SubagentQueueItem = {
        id: `sq-${++seq}`,
        tabId,
        gen: s.gen,
        text,
        state: running.get(tabId) ? 'steering' : 'queued',
      };
      s.items = [...s.items, item];
      refresh(s);
      if (item.state === 'queued') {
        pump(tabId);
        emit();
        return;
      }
      emit();
      // 运行中：先试插话，不支持（或出错）就留在原标签的队列里，等这一轮结束
      const ok = await deps.steer(tabId, text).catch(() => false);
      const own = owner(item);
      if (!own) return;
      if (ok) own.items = own.items.filter((i) => i !== item);
      else item.state = 'queued';
      refresh(own);
      pump(tabId);
      emit();
    },
    removeQueued(tabId, index) {
      const s = slots.get(tabId);
      if (!s) return;
      const target = s.items.filter((i) => i.state === 'queued' || i.state === 'failed')[index];
      if (!target) return;
      s.items = s.items.filter((i) => i !== target);
      if (s.paused && !s.items.some((i) => i.state === 'failed')) s.paused = false;
      refresh(s);
      pump(tabId);
      emit();
    },
    sync(tabs) {
      const seen = new Set<string>();
      const settled: string[] = [];
      for (const tab of tabs) {
        seen.add(tab.id);
        const next = isRunning(tab.status);
        if (running.get(tab.id) === true && !next) settled.push(tab.id);
        running.set(tab.id, next);
      }
      for (const id of [...running.keys()]) if (!seen.has(id)) running.delete(id);
      for (const [id, s] of slots) {
        if (seen.has(id)) continue;
        const lost = s.items.filter((i) => i.state !== 'sending').length;
        if (lost) log.warn('sub-task tab closed; dropping its queued messages', id, lost);
        gens.set(id, s.gen + 1);
        slots.delete(id);
      }
      // 跑完一轮：之前没发出去的接着发
      for (const id of settled) {
        const s = slots.get(id);
        if (s?.paused) {
          resume(s);
          refresh(s);
        }
      }
      for (const id of slots.keys()) pump(id);
      emit();
    },
  };
}
