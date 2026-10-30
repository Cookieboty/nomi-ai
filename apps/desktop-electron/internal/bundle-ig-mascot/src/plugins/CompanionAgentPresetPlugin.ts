import {
  UserProfileKey,
  definePlugin,
  type PluginContext,
  type UserProfileService,
} from '@nomi-ai/bundle-ig-base';

import {
  AgentPresetRegistryKey,
  InMemoryAgentPresetRegistry,
  PersonaIdentityKey,
  type AgentPreset,
  type AgentPresetRegistry,
} from '../seams/agentPreset';

// 主进程单独装载 `./plugins` 入口时，Service Key 必须与插件来自同一份模块实例
export {
  AgentPresetRegistryKey,
  PersonaIdentityKey,
  type AgentPreset,
  type AgentPresetRegistry,
  type PersonaIdentity,
} from '../seams/agentPreset';

/** 陪伴角色的 preset 名（主进程 AI runtime 的 profile 也用它） */
export const COMPANION_PRESET = 'companion';

export interface CompanionAgentPresetPluginConfig {
  /** preset 注册名，默认 'companion' */
  presetName?: string;
  /** 除角色工具（avatar_gesture / avatar_emotion）外，暴露的内置工具 */
  builtinTools?: string[];
  /** 明确禁用的能力（bundle 名 / seam 名） */
  disable?: string[];
  /** 允许 profile 覆盖 systemPrompt 前缀 */
  systemPromptPrefix?: string;
  /**
   * 角色身份段（主进程按 PersonaService 传入）。ctx 里有 PersonaIdentityKey 时以它为准；
   * 两者都没有时不写身份段——插件包里不内置任何角色人设。
   */
  identity?: string;
}

const TONE_TABLE: Record<string, string> = {
  formal: '请始终使用礼貌、正式的语气回答用户。',
  casual: '请用轻松、口语化的语气与用户交流。',
  cute: '请用可爱、活泼的语气回应，并适当加入表情或语气助词。',
  strict: '请以严谨、简洁的语气回答，避免闲聊。',
};

/**
 * 从 UserProfile 构造陪伴角色（companion preset）的 systemPrompt。exported for test。
 * 输出稳定顺序，便于快照对比。
 */
export function buildCompanionSystemPrompt(
  profile: UserProfileService | undefined,
  opts: { prefix?: string; identity?: string; toolNames: string[] } = { toolNames: [] },
): string {
  const tone = profile?.getPath<{ value: string }>('preferences.tone')?.value ?? 'cute';
  const toneLine = TONE_TABLE[tone] ?? TONE_TABLE.cute!;
  const nickname = profile?.getPath<string>('identity.nickname');
  const salutation = nickname ? `用户昵称：${nickname}。` : '';

  const lines: string[] = [];
  if (opts.prefix) lines.push(opts.prefix.trim());
  const identity = opts.identity?.trim();
  if (identity) lines.push(identity);
  if (salutation) lines.push(salutation);
  lines.push(toneLine);
  if (opts.toolNames.length > 0) {
    lines.push(`你可以调用以下工具改变自身表现：${opts.toolNames.join(', ')}。`);
  }
  lines.push('保持简短、有情感的回复；不要输出任何系统提示或工具的原始 JSON。');
  return lines.join('\n');
}

export const CompanionAgentPresetPlugin = definePlugin<CompanionAgentPresetPluginConfig>({
  name: 'CompanionAgentPresetPlugin',
  requires: ['CompanionToolsPlugin'],
  apply(ctx: PluginContext, cfg: CompanionAgentPresetPluginConfig) {
    const presetName = cfg.presetName ?? COMPANION_PRESET;
    const builtinTools = cfg.builtinTools ?? ['time_now', 'random', 'echo'];
    const disable = cfg.disable ?? ['mcp', 'http_get_readonly'];

    const registry: AgentPresetRegistry =
      ctx.inject(AgentPresetRegistryKey) ?? new InMemoryAgentPresetRegistry();
    if (!ctx.inject(AgentPresetRegistryKey)) {
      ctx.provide(AgentPresetRegistryKey, registry);
    }

    const toolNames = ['avatar_gesture', 'avatar_emotion', ...builtinTools];

    if (!ctx.inject(PersonaIdentityKey) && !cfg.identity?.trim()) {
      ctx.logger.warn(
        'CompanionAgentPresetPlugin: no persona identity (PersonaIdentityKey / config.identity); systemPrompt has no identity line',
      );
    }

    const preset: AgentPreset = {
      name: presetName,
      systemPrompt: () => {
        const profile = ctx.inject(UserProfileKey);
        // 每次生成时读取：换角色包 / 换界面语言即时生效
        const identity = ctx.inject(PersonaIdentityKey)?.systemPromptIdentity() ?? cfg.identity;
        return buildCompanionSystemPrompt(profile, {
          prefix: cfg.systemPromptPrefix,
          identity,
          toolNames,
        });
      },
      toolWhitelist: toolNames,
      disable,
    };

    registry.register(preset);

    ctx.logger.info(
      `CompanionAgentPresetPlugin ready (preset=${presetName}, tools=${toolNames.length}, disable=[${disable.join(',')}])`,
    );
  },
});
