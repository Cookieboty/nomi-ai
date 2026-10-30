/**
 * Silero VAD v5 推理内核（onnxruntime-web 的 Node/WASM 构建，单线程）。
 * 平时跑在 worker_threads 里（sileroWorker.ts），worker 不可用时由主进程直接调用（sileroNode.ts 的回退）。
 * 每个流（stream id）独立的 RNN 状态（256 floats）+ 64 样本上下文；同一会话不能并发 run，所有流串行执行。
 */
import fs from 'node:fs';

import type * as OrtNS from 'onnxruntime-web';

type Ort = typeof OrtNS;
type Session = OrtNS.InferenceSession;

export interface SileroEngine {
  /** 推理一帧（取前 512 样本 = 32ms@16kHz），返回语音概率 */
  run(stream: string, model: string, frame: Float32Array): Promise<number>;
  /** 释放某个流的状态（排在已提交的推理之后执行） */
  close(stream: string): Promise<void>;
  /** 当前持有状态的流数（测试 / 诊断用） */
  size(): number;
}

/** 主进程 → worker */
export type WorkerRequest =
  | { t: 'run'; id: number; stream: string; model: string; frame: Float32Array }
  | { t: 'close'; stream: string };

/** worker → 主进程 */
export type WorkerReply =
  { t: 'ok'; id: number; prob: number } | { t: 'err'; id: number; message: string };

interface StreamState {
  state: Float32Array;
  ctx: Float32Array;
}

export function createSileroEngine(
  loadOrt: () => Promise<unknown> = () => import('onnxruntime-web'),
): SileroEngine {
  let ortP: Promise<Ort> | null = null;
  let sessionP: Promise<Session> | null = null;
  let modelFile = '';
  let queue: Promise<void> = Promise.resolve();
  const states = new Map<string, StreamState>();

  async function session(model: string): Promise<{ ort: Ort; s: Session }> {
    if (!ortP) {
      ortP = loadOrt().then((m) => {
        const ort = ((m as { default?: Ort }).default ?? m) as Ort;
        ort.env.wasm.numThreads = 1;
        ort.env.logLevel = 'error';
        return ort;
      });
      ortP.catch(() => {
        ortP = null;
      });
    }
    const ort = await ortP;
    if (!sessionP || modelFile !== model) {
      modelFile = model;
      sessionP = ort.InferenceSession.create(new Uint8Array(fs.readFileSync(model)), {
        executionProviders: ['wasm'],
      });
      sessionP.catch(() => {
        sessionP = null;
      });
    }
    return { ort, s: await sessionP };
  }

  async function runOne(stream: string, model: string, frame: Float32Array): Promise<number> {
    const { ort, s } = await session(model);
    let st = states.get(stream);
    if (!st) {
      st = { state: new Float32Array(256), ctx: new Float32Array(64) };
      states.set(stream, st);
    }
    const x = new Float32Array(576);
    x.set(st.ctx, 0);
    x.set(frame.subarray(0, 512), 64);
    st.ctx = x.slice(512);
    const out = await s.run({
      input: new ort.Tensor('float32', x, [1, 576]),
      state: new ort.Tensor('float32', st.state, [2, 1, 128]),
      sr: new ort.Tensor('int64', BigInt64Array.from([BigInt(16000)]), []),
    });
    st.state = new Float32Array(out.stateN!.data as Float32Array);
    return Number((out.output!.data as Float32Array)[0] ?? 0);
  }

  const enqueue = <T>(fn: () => Promise<T> | T): Promise<T> => {
    const p = queue.then(fn);
    queue = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  };

  return {
    run: (stream, model, frame) => enqueue(() => runOne(stream, model, frame)),
    close: (stream) =>
      enqueue(() => {
        states.delete(stream);
      }),
    size: () => states.size,
  };
}
