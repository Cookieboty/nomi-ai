/**
 * Silero VAD 推理 worker（worker_threads）：持有 onnxruntime-web 模块、InferenceSession 与各流状态，
 * 让每秒约 31 次的推理不占主进程事件循环。协议见 sileroCore.ts 的 WorkerRequest / WorkerReply。
 */
import { parentPort } from 'node:worker_threads';

import { createSileroEngine, type WorkerReply, type WorkerRequest } from './sileroCore';

const port = parentPort;
if (port) {
  const engine = createSileroEngine();
  const reply = (m: WorkerReply) => port.postMessage(m);
  port.on('message', (m: WorkerRequest) => {
    if (m.t === 'run') {
      engine.run(m.stream, m.model, m.frame).then(
        (prob) => reply({ t: 'ok', id: m.id, prob }),
        (e: unknown) =>
          reply({ t: 'err', id: m.id, message: e instanceof Error ? e.message : String(e) }),
      );
    } else if (m.t === 'close') {
      void engine.close(m.stream);
    }
  });
}
