import {
  McpKey,
  ToolRegistryKey,
  definePlugin,
  type PluginContext,
  type ToolDefinition,
} from '@nomi-ai/bundle-ig-base';

import type { DelegateService } from '../cli/delegate/DelegateService';
import type { ExtensionsService } from '../extensions/ExtensionsService';
import type { KnowledgeService } from '../knowledge/KnowledgeService';
import type { MemoryService } from '../memory/MemoryService';

import type { DesktopService } from './DesktopService';
import { applyToolGates } from './toolGates';

/** 桌面工具插件在 apply 时读取的服务（内核实例的服务表；没有的跳过） */
export interface DesktopToolSources {
  desktop(): DesktopService | null | undefined;
  kb?(): KnowledgeService | null | undefined;
  mem?(): MemoryService | null | undefined;
  delegate?(): DelegateService | null | undefined;
  ext?(): ExtensionsService | null | undefined;
  /** 其它直接给出的工具（如生图 image_generate）；可用与否由工具自己的 available() 判断 */
  extra?(): ToolDefinition[];
  /** 持续任务（task_propose / task_recall） */
  tasks?(): ToolDefinition[];
}

/** 把桌面工具（fs_* / desktop_* / undo_last）注册进 ToolRegistry → AI SDK 工具循环可用 */
export function createDesktopToolsPlugin(src: DesktopToolSources) {
  return definePlugin<Record<string, never>>({
    name: 'DesktopToolsPlugin',
    requires: ['ToolsBuiltinPlugin'],
    apply(ctx: PluginContext) {
      const registry = ctx.inject(ToolRegistryKey);
      if (!registry) {
        ctx.logger.warn('[DesktopToolsPlugin] tools registry unavailable; skipping');
        return;
      }
      for (const t of src.desktop()?.tools() ?? []) registry.register(t);
      // 本地知识库检索（kb_search）
      for (const t of src.kb?.()?.tools() ?? []) registry.register(t);
      // 记忆检索、技能说明与参考文件是外部内容：成功返回后本轮标为读过外部内容（命令审核据此不放行中风险）
      const markRead = (signal?: AbortSignal) => src.desktop()?.broker.markRead(signal);
      // 长期记忆（memory_search / memory_remember）
      for (const t of src.mem?.()?.tools() ?? []) registry.register(markExternalRead(t, markRead));
      // 把编程助手当子代理调用（delegate_to_cli）
      for (const t of src.delegate?.()?.tools() ?? []) registry.register(t);
      // 生图（image_generate，没设置图片模型时不提供给模型）
      for (const t of src.extra?.() ?? []) registry.register(t);
      // 持续任务：起草（过授权卡片）与查询；task_recall 的结果是执行者的输出，算外部内容
      for (const t of src.tasks?.() ?? [])
        registry.register(t.name === 'task_recall' ? markExternalRead(t, markRead) : t);
      // 按需提供：对话里没提到的工具组（提醒、浏览器、文件…）不发给模型
      applyToolGates(registry);
      // 扩展：技能（skill_load / skill_read_file）+ GUI 管理的 MCP 服务器
      const ext = src.ext?.();
      if (ext) {
        for (const t of ext.tools()) registry.register(markExternalRead(t, markRead));
        ext.attach(() => ctx.inject(McpKey), registry);
      }
    },
  });
}

export function createDesktopIgPlugins(src: DesktopToolSources) {
  return [{ plugin: createDesktopToolsPlugin(src), config: {} }];
}

/**
 * 输出来自用户以外来源（过往对话摘要、第三方技能包）的工具。kb_search、文件 / 浏览器工具在工具体里自己标记；
 * MCP 工具在 ExtensionsService.withConfirm 里标记。与 Go 版 igtools_wiring.go externalReadTools 一致。
 */
const EXTERNAL_READ_TOOLS: ReadonlySet<string> = new Set([
  'memory_search',
  'skill_load',
  'skill_read_file',
]);

function markExternalRead(
  def: ToolDefinition,
  markRead: (signal?: AbortSignal) => void,
): ToolDefinition {
  if (!EXTERNAL_READ_TOOLS.has(def.name)) return def;
  return {
    ...def,
    execute: async (input, ctx) => {
      const out = await def.execute(input, ctx);
      markRead(ctx?.signal);
      return out;
    },
  } as ToolDefinition;
}
