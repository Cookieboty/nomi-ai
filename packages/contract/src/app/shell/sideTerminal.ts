/**
 * 侧边工作区内置终端（sideTerminal.*）：在 Go 内核里按标签 id 启动跨平台交互式 PTY，
 * 视图侧通过 xterm.js 收发终端流。
 */
import { z } from 'zod';

/** 终端会话身份（视图定：不带会话 scope，切会话时不重建；同一个 id 复用同一个 PTY） */
const SideTerminalId = z.string().min(1).max(512);

/** sideTerminal.open：按项目主目录或指定目录打开交互式终端（已开着则复用并返回最近输出缓冲） */
export const SideTerminalOpenInput = z.object({
  id: SideTerminalId,
  projectId: z.string().max(256).optional(),
  cwd: z.string().max(4096).optional(),
  explicitCwd: z.boolean().optional(),
  cols: z.number().int().min(10).max(500).optional(),
  rows: z.number().int().min(4).max(200).optional(),
});

/** sideTerminal.open 的结果 */
export const SideTerminalOpenResult = z.object({
  ok: z.boolean(),
  cwd: z.string().max(4096).optional(),
  shell: z.string().max(256).optional(),
  replay: z.string().optional(),
  exited: z.boolean().optional(),
  exitCode: z.number().int().optional(),
  reason: z.enum(['unsupported', 'denied', 'limit', 'failed']).optional(),
  message: z.string().max(500).optional(),
});

/** sideTerminal.write：向终端写入键盘输入（UTF-8 文本或 ANSI 序列） */
export const SideTerminalWriteInput = z.object({
  id: SideTerminalId,
  data: z.string().max(65536),
});

/** sideTerminal.resize：同步终端行列尺寸 */
export const SideTerminalResizeInput = z.object({
  id: SideTerminalId,
  cols: z.number().int().min(10).max(500),
  rows: z.number().int().min(4).max(200),
});

/** sideTerminal.close 的入参 */
export const SideTerminalIdInput = z.object({ id: SideTerminalId });

/** sideTerminal.closeAll：关闭当前全部内置终端进程 */
export const SideTerminalCloseAllInput = z.object({});

/** sideTerminal.sync：上报当前仍开着的终端 id 全集，宿主清理其余孤儿进程 */
export const SideTerminalSyncInput = z.object({
  ids: z.array(SideTerminalId).max(64),
});

/** sideTerminal.sync 的结果：本次被回收的终端 id */
export const SideTerminalSyncResult = z.object({
  closed: z.array(z.string()).max(64),
});

/** sideTerminal.data：终端原始字节输出（Base64 编码，避免多字节 UTF-8 跨块截断） */
export const SideTerminalData = z.object({
  id: z.string(),
  data: z.string(),
});

/** sideTerminal.exit：终端 shell 进程退出 */
export const SideTerminalExit = z.object({
  id: z.string(),
  exitCode: z.number().int().optional(),
  signal: z.string().max(64).optional(),
  message: z.string().max(500).optional(),
});
