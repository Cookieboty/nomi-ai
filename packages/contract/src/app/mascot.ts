/**
 * D5 · 看板娘窗口 / 角色 / 灵动岛 / 聊天背景 / 文件 / 窗口（docs/design/core-host-decoupling.md §12 P1b）。
 *
 * 本文件只属于 D5：过程、事件、业务错误码都在这里声明，`app/index.ts` 负责汇总。
 * 命名空间：mascot、character、persona、island、chatBg、files、window（过程 / 事件名 `<命名空间>.<方法>`，驼峰，不用连字符）。
 *
 * 旧面（迁入后由收尾批次删除）：
 * - `mascot:*`（mascot/MascotWindowController.ts、ai/mascotCommand.ts；electronAPI.mascotWindow / mascot / onMascotCommand）
 * - `character-pack:get-active`、`character:get-persona` / `character:persona-changed`（electronAPI.characterPack / persona）
 * - `island:*`、`chat-bg:*`（electronAPI.island / chatBg）、electronAPI.files.pathFor、electronAPI.platform
 * - 旧窗口通道（handlers/ipc/WindowIpcHandler.ts、ConfigIpcHandler 的 save-model / get-saved-model）：
 *   quit-app、set-always-on-top、move-window、get/set-position、get-cursor-position、open-ai-chat、
 *   open-task-board、open-voice-settings、window-mouse-enter/leave
 *
 * 约定见设计稿 §12「P1b 实施约定」：zod schema 从现有类型写、只用可序列化值；
 * 读用 query、写用 mutation、进度流用 stream；只给一个窗口用的过程写 `surfaces`，
 * 原来要用户确认的写 `dangerous: true`。
 */

import type { EventMap, ProcedureMap } from '../contract';

export const mascotProcedures = {} as const satisfies ProcedureMap;

export const mascotEvents = {} as const satisfies EventMap;

/** 业务错误码（UPPER_SNAKE_CASE，不得与其他域重名）；处理函数用 `ctx.fail(code, message)` 抛出 */
export const mascotErrors = [] as const satisfies readonly string[];

export type MascotProcedureName = keyof typeof mascotProcedures & string;
export type MascotEventName = keyof typeof mascotEvents & string;
