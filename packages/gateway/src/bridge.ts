/**
 * 协议桥（docs/design/cli-plugin-architecture.md §6.5）：把上游（已规范化的）事件流写成入口协议。
 * - 透传模式（同协议、计划没要求结构修复）：按事件原样输出；Chat 走字段归一与事件级修正，其它协议
 *   只在开了复读检测时旁路解码；按完整事件转发，没有任何修正时输出与上游一致。
 *   旁路做结束检测：上游没发结束标记就断开时丢掉半截事件、补一个入口协议的失败事件。
 * - 转换模式（跨协议，或同协议但需要结构修复，如 custom 工具转函数）：解码 → NormEvent → 修正 → 编码。
 * Responses 入口的输出最后都过一遍规范化（ResponsesCanonicalizer），给严格客户端补齐必填字段。
 * 输入、输出都是 SSE 文本分片；不缓存整段，只缓存当前未完整的事件（背压由调用方处理，§6.11.4）。
 */
import { ResponsesCanonicalizer } from './canonical/responses';
import { TerminalWatch } from './canonical/terminal';
import type { Wire } from './ir';
import type { ChatPatchOptions } from './stream/chatPatch';
import { createStreamConverter, type StreamConverter } from './stream/index';
import { createPassthrough, passthroughFail, type Passthrough } from './stream/passthrough';

export type BridgeMode = 'passthrough' | 'convert';

/** 桥的计划（RoutePlan 的响应部分，§6.9.4） */
export interface BridgePlan {
  /** 上游协议 */
  from: Wire;
  /** 入口协议 */
  to: Wire;
  mode: BridgeMode;
  /** 对外的模型名（编码器 / 规范化补 model 用） */
  model: string;
  /** Responses 入口的 custom 工具名（转换模式回程还原成 custom_tool_call） */
  customTools?: ReadonlySet<string>;
  /** 响应方向的修正开关与备注（§11.3） */
  fixes: ChatPatchOptions;
}

export interface Bridge {
  readonly mode: BridgeMode;
  /** 上游的一段文本 → 要写给客户端的文本（透传时按完整事件转发，没修正的事件与上游一致） */
  push(text: string): string;
  /** 上游正常读完：rest 是解码器里剩下的最后一段文本 */
  end(rest?: string): string;
  /** 上游中途失败（网络中断、空闲超时）→ 入口协议的错误事件 */
  fail(message: string): string;
  /** 修正决定提前结束（复读检测）：调用方停止读上游 */
  readonly stopped: boolean;
}

/** SSE 事件的结尾：空行（LF 或 CRLF，可混用） */
const EVENT_END = /\r?\n\r?\n/g;

/** 透传时上游没发结束标记就断开的说明 */
export const TRUNCATED_MESSAGE = 'Nomi 网关：上游没有发结束标记就断开了';

/** 计划的桥接模式：同协议且不需要转换 → 透传 */
export function bridgeMode(from: Wire, to: Wire, needsConversion = false): BridgeMode {
  return from === to && !needsConversion ? 'passthrough' : 'convert';
}

export function createBridge(plan: BridgePlan): Bridge {
  const passthrough = plan.mode === 'passthrough';
  const pass: Passthrough | null = passthrough ? createPassthrough(plan.from, plan.fixes) : null;
  const watch = passthrough ? new TerminalWatch(plan.from) : null;
  const conv: StreamConverter | null = passthrough
    ? null
    : createStreamConverter(plan.from, plan.to, {
        model: plan.model,
        customTools: plan.customTools,
        fixes: plan.fixes,
      });
  const canon = plan.to === 'responses' ? new ResponsesCanonicalizer(plan.model) : null;
  const write = (chunk: string) => (canon ? canon.push(chunk) : chunk);
  const stopped = () => conv?.stopped === true || pass?.stopped === true;
  // 透传按完整事件转发：上游在一个事件中间断开时，半截事件不能发给客户端（后面补的失败事件会和它
  // 粘在一起，严格客户端解析失败）。事件很小，等到结尾空行再转发不影响首字时间
  let pending = '';
  const frame = (text: string): string => {
    pending += text;
    let end = -1;
    for (const m of pending.matchAll(EVENT_END)) end = m.index + m[0].length;
    if (end < 0) return '';
    const out = pending.slice(0, end);
    pending = pending.slice(end);
    return out;
  };
  const forward = (events: string) => write(pass ? pass.push(events) : events);
  return {
    mode: plan.mode,
    push(text) {
      if (conv) return write(conv.push(text));
      const events = frame(text);
      if (!events) return '';
      watch?.push(events);
      return forward(events);
    },
    end(rest = '') {
      let out = '';
      const halted = stopped();
      if (!halted) {
        if (conv) out += write(conv.push(rest) + conv.end());
        else {
          out += forward(frame(rest));
          // 最后一个事件可能不带结尾空行：它让流正常结束时照常转发，否则是被截断的半截，丢掉
          const last = pending;
          pending = '';
          watch?.push(last);
          if (last.trim() && watch?.terminated) out += forward(last);
          if (pass) out += write(pass.end());
        }
      }
      if (canon) out += canon.end();
      // 同协议透传时上游没发结束标记就断了：补一个失败事件，客户端报错而不是空等 / 静默重试
      if (watch && !halted && !watch.terminated)
        out += write(passthroughFail(plan.from, TRUNCATED_MESSAGE));
      return out;
    },
    fail(message) {
      pending = '';
      // 已收到的完整事件先写出去（Responses 规范化层还缓存着的部分，#94），再报错
      const tail = canon?.end() ?? '';
      return tail + (conv ? conv.fail(message) : write(passthroughFail(plan.from, message)));
    },
    get stopped() {
      return stopped();
    },
  };
}
