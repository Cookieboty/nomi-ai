/**
 * 生产构建里的「轻校验」：高频路径（流式 chunk、高频事件、chunk / event 帧外壳）与列出的大结果过程
 * （整段会话消息、整份 diff 这类几 MB 的结果）跳过 zod 校验，省掉流式时每帧、切到长会话时整份的 schema 遍历
 * 与 z.object 复制出的那份副本。默认关闭（开发与测试全量校验，行为不变）；视图在
 * `services/api.ts` 里按 `import.meta.env.PROD` 打开（库本身不判断构建环境）。
 *
 * 只跳过校验，不改数据：应用契约的 schema 里没有 default / transform，校验通过时拿到的值与原值相同
 * （差别只在 z.object 会去掉没声明的字段）。请求入参、其余调用结果、流的最终结果、低频事件照常校验。
 *
 * 存在 globalThis 上：本包可能被不同入口各打包一份，共用一个开关。
 */

const KEY = Symbol.for('nomi.contract.leanValidation');

export interface LeanValidation {
  /** 跳过载荷校验的事件名 */
  events: ReadonlySet<string>;
  /** 跳过结果校验的过程名（大结果） */
  procedures: ReadonlySet<string>;
}

type Store = Record<symbol, LeanValidation | undefined>;

/** 打开（传高频事件名、大结果过程名）或关闭（false）轻校验 */
export function setLeanValidation(
  opts: { events?: Iterable<string>; procedures?: Iterable<string> } | false,
): void {
  (globalThis as unknown as Store)[KEY] = opts
    ? { events: new Set(opts.events ?? []), procedures: new Set(opts.procedures ?? []) }
    : undefined;
}

/** 当前的轻校验设置；未打开时 undefined（全量校验） */
export function leanValidation(): LeanValidation | undefined {
  return (globalThis as unknown as Store)[KEY];
}
