/**
 * 把供应商预处理（ProviderStage）套在上游响应的字节流上：提交点（commit.ts）和协议桥看到的都是
 * 预处理之后的流，伪装成正文增量的保活不会被当成「第一个内容事件」提前提交。
 * 丢掉保活后这一块没有输出时也送一个空块出去，让读取方及时看到 stage.alive、给客户端发心跳。
 */
import type { ProviderStage } from './index';

export function stagedResponse(
  up: Response,
  stage: ProviderStage,
  /** 上游原始文本（诊断追踪记录全文用，§8.4） */
  onRaw?: (text: string) => void,
): Response {
  if (!up.body) return up;
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  const emit = (ctrl: TransformStreamDefaultController<Uint8Array>, text: string) => {
    if (text) ctrl.enqueue(enc.encode(text));
    else if (stage.alive) ctrl.enqueue(new Uint8Array(0));
  };
  const body = up.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctrl) {
        const t = dec.decode(chunk, { stream: true });
        onRaw?.(t);
        emit(ctrl, stage.push(t));
      },
      flush(ctrl) {
        const t = dec.decode();
        if (t) onRaw?.(t);
        emit(ctrl, stage.push(t) + stage.end());
      },
    }),
  );
  return new Response(body, { status: up.status, statusText: up.statusText, headers: up.headers });
}
