/**
 * D2 · 应用外壳（docs/design/core-host-decoupling.md §12 P1b）。
 *
 * 本文件只属于 D2：过程、事件、业务错误码都在这里声明，`app/index.ts` 负责汇总。
 * 命名空间：app、theme、locale、startup、onboarding、providers、gateway、usage、quality、updates、diagnostics、appIcon（过程 / 事件名 `<命名空间>.<方法>`，驼峰，不用连字符）。
 *
 * 旧面（迁入后由收尾批次删除）：
 * - `ai:theme:*`、`ai:locale:*`（packages/ui 的 theme.ts / i18n.ts）、`ai:startup:*`、`ai:onboarding:*`
 * - `ai:providers:*`（ai-runtime ProviderIpcServer，含事件 `ai:providers:changed` / `ai:providers:open-panel`）
 * - `ai:gateway:*`（含 TerminalCommands 的 `ai:gateway:terminal-*`）、`ai:usage:*`、`ai:quality:*`
 * - `updates:*`、`diagnostics:*`、`app-icon:*`（electronAPI.updates / diagnostics / appIcon）
 *
 * 约定见设计稿 §12「P1b 实施约定」：zod schema 从现有类型写、只用可序列化值；
 * 读用 query、写用 mutation、进度流用 stream；只给一个窗口用的过程写 `surfaces`，
 * 原来要用户确认的写 `dangerous: true`。
 */

import type { EventMap, ProcedureMap } from '../contract';

export const shellProcedures = {} as const satisfies ProcedureMap;

export const shellEvents = {} as const satisfies EventMap;

/** 业务错误码（UPPER_SNAKE_CASE，不得与其他域重名）；处理函数用 `ctx.fail(code, message)` 抛出 */
export const shellErrors = [] as const satisfies readonly string[];

export type ShellProcedureName = keyof typeof shellProcedures & string;
export type ShellEventName = keyof typeof shellEvents & string;
