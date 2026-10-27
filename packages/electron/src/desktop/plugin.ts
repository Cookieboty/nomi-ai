import { McpKey, ToolRegistryKey, definePlugin, type PluginContext } from '@nomi-ai/bundle-ig-base';

import { getDelegateService } from '../cli/delegate/DelegateService';
import { getExtensionsService } from '../extensions/ExtensionsService';
import { getKnowledgeService } from '../knowledge/KnowledgeService';
import { getLocalHubService } from '../local/LocalHubService';
import { getMediaService } from '../media/MediaService';
import { getMemoryService } from '../memory/MemoryService';
import { getScreenService } from '../screen/ScreenService';

import { getDesktopService } from './DesktopService';

/** 把桌面工具（fs_* / desktop_* / undo_last）注册进 ToolRegistry → AI SDK 工具循环可用 */
export const DesktopToolsPlugin = definePlugin<Record<string, never>>({
  name: 'DesktopToolsPlugin',
  requires: ['ToolsBuiltinPlugin'],
  apply(ctx: PluginContext) {
    const registry = ctx.inject(ToolRegistryKey);
    if (!registry) {
      ctx.logger.warn('[DesktopToolsPlugin] tools registry unavailable; skipping');
      return;
    }
    for (const t of getDesktopService().tools()) registry.register(t);
    // 本地知识库检索（kb_search）
    for (const t of getKnowledgeService()?.tools() ?? []) registry.register(t);
    for (const t of getMediaService()?.tools() ?? []) registry.register(t);
    // 长期记忆（memory_search / memory_remember）
    for (const t of getMemoryService()?.tools() ?? []) registry.register(t);
    // 屏幕记忆（screen_memory_search，默认关闭）
    for (const t of getScreenService()?.tools() ?? []) registry.register(t);
    // 本地日历（calendar_list）
    for (const t of getLocalHubService()?.tools() ?? []) registry.register(t);
    // 把编程助手当子代理调用（delegate_to_cli）
    for (const t of getDelegateService()?.tools() ?? []) registry.register(t);
    // 扩展：技能（skill_load / skill_read_file）+ GUI 管理的 MCP 服务器
    const ext = getExtensionsService();
    if (ext) {
      for (const t of ext.tools()) registry.register(t);
      ext.attach(() => ctx.inject(McpKey), registry);
    }
  },
});

export const desktopIgPlugins = [{ plugin: DesktopToolsPlugin, config: {} }];
