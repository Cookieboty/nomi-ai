/**
 * 把 PersonaService 的身份段注入 AI 插件上下文（PersonaIdentityKey）。
 * 角色 preset（bundle-ig-mascot 的 CompanionAgentPresetPlugin）从这里读人设，插件包里不写任何角色。
 */
import { definePlugin, type PluginContext } from '@nomi-ai/bundle-ig-base';
import { PersonaIdentityKey } from '@nomi-ai/bundle-ig-mascot/plugins';

import type { Persona } from './PersonaService';

export function createPersonaIdentityPlugin(getPersona: () => Persona | undefined) {
  return definePlugin<Record<string, never>>({
    name: 'PersonaIdentityPlugin',
    apply(ctx: PluginContext) {
      ctx.provide(PersonaIdentityKey, {
        systemPromptIdentity: () => getPersona()?.systemPromptIdentity,
      });
    },
  });
}
