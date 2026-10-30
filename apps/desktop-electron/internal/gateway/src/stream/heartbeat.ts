/**
 * 给客户端的心跳（§6.6，审查意见 I3）：供应商适配器丢掉的保活、上游长时间只有编码器不输出的推理时，
 * 按入口协议发一个不影响内容的事件，CLI 的空闲计时（Claude Code 默认 300 秒）不会误判。
 * - Messages：官方协议本来就有 `ping` 事件；
 * - 其它协议：SSE 注释（`: keepalive`），按 SSE 规范解析器一律忽略，严格客户端也不受影响。
 * 客户端规格（P6）只决定形式，不决定要不要。
 */
import type { Wire } from '../ir';

export type HeartbeatKind = 'comment' | 'ping';

export const HEARTBEAT_COMMENT = ': keepalive\n\n';
export const HEARTBEAT_PING = 'event: ping\ndata: {"type":"ping"}\n\n';

export function defaultHeartbeatKind(wire: Wire): HeartbeatKind {
  return wire === 'messages' ? 'ping' : 'comment';
}

export function heartbeat(wire: Wire, kind: HeartbeatKind = defaultHeartbeatKind(wire)): string {
  return kind === 'ping' && wire === 'messages' ? HEARTBEAT_PING : HEARTBEAT_COMMENT;
}
