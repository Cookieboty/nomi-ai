import { McpKey, ToolRegistryKey, definePlugin, type PluginContext } from '@nomi-ai/bundle-ig-base';

import type { DelegateService } from '../cli/delegate/DelegateService';
import type { ExtensionsService } from '../extensions/ExtensionsService';
import type { KnowledgeService } from '../knowledge/KnowledgeService';
import type { MemoryService } from '../memory/MemoryService';

import type { DesktopService } from './DesktopService';

/** 桌面工具插件在 apply 时读取的服务（内核实例的服务表；没有的跳过） */
export interface DesktopToolSources {
  desktop(): DesktopService | null | undefined;
  kb?(): KnowledgeService | null | undefined;
  mem?(): MemoryService | null | undefined;
  delegate?(): DelegateService | null | undefined;
  ext?(): ExtensionsService | null | undefined;
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
      // 长期记忆（memory_search / memory_remember）
      for (const t of src.mem?.()?.tools() ?? []) registry.register(t);
      // 把编程助手当子代理调用（delegate_to_cli）
      for (const t of src.delegate?.()?.tools() ?? []) registry.register(t);
      // 扩展：技能（skill_load / skill_read_file）+ GUI 管理的 MCP 服务器
      const ext = src.ext?.();
      if (ext) {
        for (const t of ext.tools()) registry.register(t);
        ext.attach(() => ctx.inject(McpKey), registry);
      }
    },
  });
}

export function createDesktopIgPlugins(src: DesktopToolSources) {
  return [{ plugin: createDesktopToolsPlugin(src), config: {} }];
}
