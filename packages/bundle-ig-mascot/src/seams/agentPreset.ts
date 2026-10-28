import { defineService } from '@nomi-ai/bundle-ig-base';

/**
 * Agent Preset —— 会话预设。
 *
 * P4 阶段只做结构与注册中心；P5/P6 agent runtime 落地后，`ctx.agents.create({ preset })`
 * 会读取本注册中心。
 */
export interface AgentPreset {
  /** 唯一 id，例如 'waifu' */
  name: string;
  /** systemPrompt 生成器；每次会话开始时调用一次，可读取 ctx.userProfile 等运行期状态 */
  systemPrompt: () => string | Promise<string>;
  /** 允许使用的工具白名单（tool name），undefined 表示继承默认 */
  toolWhitelist?: string[];
  /** 显式禁用的能力（bundle 层可选粒度：如 'mcp'、'http_get_readonly'） */
  disable?: string[];
}

export interface AgentPresetRegistry {
  register(preset: AgentPreset): void;
  get(name: string): AgentPreset | undefined;
  list(): AgentPreset[];
}

export const AgentPresetRegistryKey = defineService<AgentPresetRegistry>('ctx.agentPresets');

/**
 * 角色身份（docs/design/core-host-decoupling.md §10.4）：由主进程 PersonaService 提供，
 * 插件包里不写任何角色名或人设文本。每次生成 systemPrompt 时读取，换角色包 / 换语言即时生效。
 */
export interface PersonaIdentity {
  /** 系统提示里的身份段；没有可用人设时返回 undefined */
  systemPromptIdentity(): string | undefined;
}

export const PersonaIdentityKey = defineService<PersonaIdentity>('ctx.personaIdentity');

/** 骨架期的默认内存实现；消费方也可 provide 自己的 registry。 */
export class InMemoryAgentPresetRegistry implements AgentPresetRegistry {
  private readonly map = new Map<string, AgentPreset>();
  register(preset: AgentPreset): void {
    this.map.set(preset.name, preset);
  }
  get(name: string): AgentPreset | undefined {
    return this.map.get(name);
  }
  list(): AgentPreset[] {
    return [...this.map.values()];
  }
}
