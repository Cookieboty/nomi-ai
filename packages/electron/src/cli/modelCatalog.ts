/**
 * 官方账号 / CLI 自带配置路径下的模型目录与覆盖参数（通用逻辑在 @nomi-ai/cli-sdk 的 models，
 * 各 CLI 的目录解析与覆盖参数在内置插件的 <cli>/models；这里只转出并按后端分派）。
 *
 * 模型列表、每个模型支持的思考档位、默认档位一律从 CLI 自己读取（见 modelDiscovery.ts），
 * 这里不写死任何模型或档位集：
 * - Claude Code：stream-json `initialize` 控制请求的 `models`（与 `/model` 选择器同源）
 * - Codex：`codex debug models`（随当前生效的配置 / 供应商刷新）
 * - Grok：`grok agent stdio`（ACP）`session/new` 返回的 `models`
 * Gemini（ACP）/ dsh 暂不支持标签级覆盖。
 *
 * 与「第三方供应商」（改写 CLI 配置）互斥：这里只提供「标签级覆盖」的元数据，
 * 覆盖参数在每轮启动时以进程级参数（`-c` / `--model` / `-m` …）注入，不改写用户的
 * 全局 CLI 配置，因此终端里直接运行的 CLI 不受影响。
 */
import { claude, codex, dsh, gemini, grok } from '@nomi-ai/cli-plugins/main';
import {
  isReasoningEffort,
  isValidModelId,
  type ReasoningEffort as SdkReasoningEffort,
} from '@nomi-ai/cli-sdk';
import type { ReasoningEffort } from '@nomi-ai/types';

import type { HarnessBackend } from './types';

export {
  REASONING_EFFORTS,
  effortsForModel,
  isReasoningEffort,
  isValidModelId,
  normalizeEfforts,
  providerCatalog,
  sanitizeEffort,
  type BackendModelCatalog,
  type CatalogModel,
} from '@nomi-ai/cli-sdk';
export {
  parseClaudeModels,
  parseCodexModels,
  parseGrokModels,
  readCodexConfigDefaults,
} from '@nomi-ai/cli-plugins/main';

/** 编程助手后端（排除 Nomi 自有） */
export type CliBackend = Exclude<HarnessBackend, 'nomi'>;

export type { ReasoningEffort };

// 契约包里的档位类型与 @nomi-ai/types 的必须一致（两边任何一边改了都在这里编译失败）
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _effortsInSync: Same<ReasoningEffort, SdkReasoningEffort> = true;
void _effortsInSync;

type ModelArgs = (o: { model?: string | null; effort?: ReasoningEffort | null }) => string[];
const argsOf = (p: object): ModelArgs | undefined => (p as { modelArgs?: ModelArgs }).modelArgs;

/** 有无头覆盖参数（模型 / 思考深度）的后端：插件实现了 modelArgs 的（Gemini ACP / dsh 暂无） */
const MODEL_ARGS: Record<CliBackend, ModelArgs | undefined> = {
  claude: argsOf(claude),
  codex: argsOf(codex),
  dsh: argsOf(dsh),
  gemini: argsOf(gemini),
  grok: argsOf(grok),
  // 外部 ACP CLI（L1）：没有模型覆盖参数，换模型按重启处理
  external: undefined,
};

export function supportsModelOverride(backend: string): backend is CliBackend {
  return Boolean((MODEL_ARGS as Partial<Record<string, ModelArgs>>)[backend]);
}

/**
 * 模型名是否允许用于该后端：只做字符集校验（目录随账号 / 供应商变化，不能拿来卡死），
 * 是否真的可用由 CLI 报错说明。
 */
export function isAllowedModelId(backend: string, model: string): boolean {
  return supportsModelOverride(backend) && isValidModelId(model);
}

/**
 * 各后端无头模式的进程级覆盖参数（模型 / 思考深度），由插件的 modelArgs 给出。
 * 模型合法性由调用方（setTabModel）保证；档位是否被该模型支持由调用方按目录校验。
 */
export function overrideArgs(
  backend: CliBackend,
  o: { model?: string | null; effort?: string | null },
): string[] {
  const effort = isReasoningEffort(o.effort) ? o.effort : null;
  return MODEL_ARGS[backend]?.({ model: o.model, effort }) ?? [];
}
