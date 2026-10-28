/**
 * D4 · 知识库 / 记忆 / 日程 / 本地模型 / 扩展（docs/design/core-host-decoupling.md §12 P1b）。
 *
 * 本文件只属于 D4：过程、事件、业务错误码都在这里声明，`app/index.ts` 负责汇总。
 * 命名空间：kb、mem、sched、local、hub、ext（过程 / 事件名 `<命名空间>.<方法>`，驼峰，不用连字符）。
 *
 * 旧面（迁入后由收尾批次删除）：
 * - `ai:kb:*`、`ai:mem:*`、`ai:sched:*`
 * - `ai:local:*`（LocalModelService，通道名由 `ai:local:${ch}` 拼出）、`ai:hub:export`
 * - `ai:ext:*`（ExtensionsService，通道名由 `ai:ext:${ch}` 拼出）
 *
 * 约定见设计稿 §12「P1b 实施约定」：zod schema 从现有类型写、只用可序列化值；
 * 读用 query、写用 mutation、进度流用 stream；只给一个窗口用的过程写 `surfaces`，
 * 原来要用户确认的写 `dangerous: true`。
 */

import type { EventMap, ProcedureMap } from '../contract';

export const knowledgeProcedures = {} as const satisfies ProcedureMap;

export const knowledgeEvents = {} as const satisfies EventMap;

/** 业务错误码（UPPER_SNAKE_CASE，不得与其他域重名）；处理函数用 `ctx.fail(code, message)` 抛出 */
export const knowledgeErrors = [] as const satisfies readonly string[];

export type KnowledgeProcedureName = keyof typeof knowledgeProcedures & string;
export type KnowledgeEventName = keyof typeof knowledgeEvents & string;
