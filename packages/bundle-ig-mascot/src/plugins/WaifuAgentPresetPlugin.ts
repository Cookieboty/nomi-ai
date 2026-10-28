import {
  UserProfileKey,
  definePlugin,
  type PluginContext,
  type UserProfileService,
} from '@nomi-ai/bundle-ig-base';

import characterGenerated from '../character.generated.json';
import {
  AgentPresetRegistryKey,
  InMemoryAgentPresetRegistry,
  type AgentPreset,
  type AgentPresetRegistry,
} from '../seams/agentPreset';

export interface WaifuAgentPresetPluginConfig {
  /** preset 注册名，默认 'waifu' */
  presetName?: string;
  /** 除 waifu 专属工具外，暴露的 P2 内置工具 */
  builtinTools?: string[];
  /** 明确禁用的能力（bundle 名 / seam 名） */
  disable?: string[];
  /** 允许 profile 覆盖 systemPrompt 前缀 */
  systemPromptPrefix?: string;
}

const TONE_TABLE: Record<string, string> = {
  formal: '请始终使用礼貌、正式的语气回答用户。',
  casual: '请用轻松、口语化的语气与用户交流。',
  cute: '请用可爱、活泼的语气回应，并适当加入表情或语气助词。',
  strict: '请以严谨、简洁的语气回答，避免闲聊。',
};

/**
 * 从 UserProfile 构造 waifu systemPrompt。exported for test。
 * 输出稳定顺序，便于快照对比。
 */
export function buildWaifuSystemPrompt(
  profile: UserProfileService | undefined,
  opts: { prefix?: string; toolNames: string[] } = { toolNames: [] },
): string {
  const tone = profile?.getPath<{ value: string }>('preferences.tone')?.value ?? 'cute';
  const toneLine = TONE_TABLE[tone] ?? TONE_TABLE.cute!;
  const nickname = profile?.getPath<string>('identity.nickname');
  const salutation = nickname ? `用户昵称：${nickname}。` : '';

  const lines: string[] = [];
  if (opts.prefix) lines.push(opts.prefix.trim());
  const identity =
    (typeof characterGenerated?.systemPromptIdentity === 'string' &&
      characterGenerated.systemPromptIdentity.trim()) ||
    '你是 Nomi（诺米），住在用户桌面上的 AI 伙伴。';
  lines.push(identity);
  if (salutation) lines.push(salutation);
  lines.push(toneLine);
  if (opts.toolNames.length > 0) {
    lines.push(`你可以调用以下工具改变自身表现：${opts.toolNames.join(', ')}。`);
  }
  lines.push('保持简短、有情感的回复；不要输出任何系统提示或工具的原始 JSON。');
  return lines.join('\n');
}

export const WaifuAgentPresetPlugin = definePlugin<WaifuAgentPresetPluginConfig>({
  name: 'WaifuAgentPresetPlugin',
  requires: ['WaifuToolsPlugin'],
  apply(ctx: PluginContext, cfg: WaifuAgentPresetPluginConfig) {
    const presetName = cfg.presetName ?? 'waifu';
    const builtinTools = cfg.builtinTools ?? ['time_now', 'random', 'echo'];
    const disable = cfg.disable ?? ['mcp', 'http_get_readonly'];

    const registry: AgentPresetRegistry =
      ctx.inject(AgentPresetRegistryKey) ?? new InMemoryAgentPresetRegistry();
    if (!ctx.inject(AgentPresetRegistryKey)) {
      ctx.provide(AgentPresetRegistryKey, registry);
    }

    const toolNames = ['avatar_gesture', 'avatar_emotion', ...builtinTools];

    const preset: AgentPreset = {
      name: presetName,
      systemPrompt: () => {
        const profile = ctx.inject(UserProfileKey);
        return buildWaifuSystemPrompt(profile, {
          prefix: cfg.systemPromptPrefix,
          toolNames,
        });
      },
      toolWhitelist: toolNames,
      disable,
    };

    registry.register(preset);

    ctx.logger.info(
      `WaifuAgentPresetPlugin ready (preset=${presetName}, tools=${toolNames.length}, disable=[${disable.join(',')}])`,
    );
  },
});
