/** 长对话分页窗口计算、轮次分组与视口滚动锚点捕获（纯工具，从 Conversation/index 拆出） */
import type { ConvMessage } from '../../types/conversation';

export const WINDOW_MESSAGES = 30;
export const WINDOW_BUDGET = 400;
export const LOAD_MORE_STEP = 30;
export const LOAD_EARLIER_THRESHOLD = 320;
/** 会话视图首帧渲染的末尾消息条数，以及之后每批往上补多少条 */
export const INITIAL_RENDER = 3;
export const RENDER_STEP = 6;

/** 估算一条消息的渲染成本：正文每 400 字符 1；极简模式下轨迹已折叠成单行，按固定小权重计，避免首屏被误裁成 1 轮 */
function messageWeight(m: Pick<ConvMessage, 'text' | 'trace' | 'error'>, minimal = false): number {
  const traceWeight = minimal ? (m.trace?.length ? 2 : 0) : (m.trace?.length ?? 0) * 0.5;
  return Math.max(1, ((m.text?.length ?? 0) + (m.error?.length ?? 0)) / 400 + traceWeight);
}

/** 一次发送一轮：用户消息领起，随后的助手消息直到下一条用户消息都算这一轮 */
export function groupTurns(
  messages: readonly ConvMessage[],
): { key: string; messages: ConvMessage[] }[] {
  const turns: { key: string; messages: ConvMessage[] }[] = [];
  for (const m of messages) {
    const last = turns[turns.length - 1];
    if (m.role === 'user' || !last) turns.push({ key: m.id, messages: [m] });
    else last.messages.push(m);
  }
  return turns;
}

/** 长对话分页：从末尾往前取，直到条数达到 limit 或体量预算用完（至少 1 条）；返回起始下标。 */
export function windowStart(
  messages: readonly Pick<ConvMessage, 'text' | 'trace' | 'error'>[],
  extra = 0,
  opts?: { minimal?: boolean },
): number {
  const limit = WINDOW_MESSAGES + extra;
  let budget = WINDOW_BUDGET + extra * 10;
  let i = messages.length;
  while (i > 0 && messages.length - i < limit) {
    const w = messageWeight(messages[i - 1]!, opts?.minimal);
    // 体量预算只约束首屏。用户加载过更早消息之后按条数放开，避免超长轨迹卡死分页
    if (extra === 0 && budget - w < 0 && i < messages.length) break;
    budget -= w;
    i--;
  }
  return i;
}

/** 窗口起点落在一轮中间时，回退到该轮用户消息，避免第一轮被助手 id 错标成 0。 */
export function snapStartToTurn(
  messages: readonly Pick<ConvMessage, 'role'>[],
  start: number,
): number {
  if (start <= 0 || messages.length === 0) return 0;
  let i = Math.min(start, messages.length - 1);
  while (i > 0 && messages[i]!.role !== 'user') i--;
  return i;
}

/** 第 turnIndex 轮第一条消息在全部消息中的下标（与 groupTurns 同一规则）。 */
export function turnStartMessageIndex(
  messages: readonly Pick<ConvMessage, 'role'>[],
  turnIndex: number,
): number {
  let current = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === 'user' || current < 0) current += 1;
    if (current === turnIndex) return i;
  }
  return 0;
}

/** 让分页窗口覆盖到 messageIndex 所需的 extra（一次算够，避免跳转时反复 +30）。 */
export function extraToReachMessage(
  messages: readonly Pick<ConvMessage, 'text' | 'trace' | 'error'>[],
  messageIndex: number,
  opts?: { minimal?: boolean },
): number {
  const target = Math.max(0, Math.min(messageIndex, Math.max(0, messages.length - 1)));
  if (windowStart(messages, 0, opts) <= target) return 0;
  let lo = 1;
  let hi = messages.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (windowStart(messages, mid, opts) <= target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

export interface ScrollAnchor {
  turnIndex: string | null;
  offsetTop: number;
  scrollHeight: number;
}

/** 捕获当前视口内最靠上的轮次元素及其相对滚区顶边的偏移，供向上加载历史后精准还原位置 */
export function captureScrollAnchor(scroller: HTMLElement): ScrollAnchor {
  const box = scroller.getBoundingClientRect();
  const turns = scroller.querySelectorAll<HTMLElement>('[data-testid="conv-turn"]');
  for (const el of turns) {
    const rect = el.getBoundingClientRect();
    if (rect.height <= 0) continue;
    if (rect.bottom > box.top + 1) {
      return {
        turnIndex: el.dataset.turnIndex ?? null,
        offsetTop: rect.top - box.top,
        scrollHeight: scroller.scrollHeight,
      };
    }
  }
  return { turnIndex: null, offsetTop: 0, scrollHeight: scroller.scrollHeight };
}
