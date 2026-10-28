/**
 * D3 · 编程助手（docs/design/core-host-decoupling.md §12 P1b）。
 *
 * 本文件只属于 D3：过程、事件、业务错误码都在这里声明，`app/index.ts` 负责汇总。
 * 命名空间：harness、cli、cliAccount、cliUpdate、delegate、agents、history（过程 / 事件名 `<命名空间>.<方法>`，驼峰，不用连字符）。
 *
 * 旧面（迁入后由收尾批次删除）：
 * - `ai:harness:*`（cli/harness/Orchestrator.ts + rendererSubscribers.ts）
 * - `ai:cli:*`（CliPluginHost）、`ai:cli-account:*`（AccountService / AccountLogin）、`ai:cli-update:*`
 * - `ai:delegate:*`、`ai:agents:*`、`ai:history:*`
 *
 * 约定见设计稿 §12「P1b 实施约定」：zod schema 从现有类型写、只用可序列化值；
 * 读用 query、写用 mutation、进度流用 stream；只给一个窗口用的过程写 `surfaces`，
 * 原来要用户确认的写 `dangerous: true`。
 */

import type { EventMap, ProcedureMap } from '../contract';

export const codingProcedures = {} as const satisfies ProcedureMap;

export const codingEvents = {} as const satisfies EventMap;

/** 业务错误码（UPPER_SNAKE_CASE，不得与其他域重名）；处理函数用 `ctx.fail(code, message)` 抛出 */
export const codingErrors = [] as const satisfies readonly string[];

export type CodingProcedureName = keyof typeof codingProcedures & string;
export type CodingEventName = keyof typeof codingEvents & string;
