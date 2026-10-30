/**
 * Fake seams —— 无界面 E2E 专用，由 `headlessCore.ts` 的探针插件装进真实内核的插件宿主。
 *
 * - `createFakeLLM` / `createFakeLLMRegistry`：确定的对话结果，记录调用；
 * - `createFakeAvatarService`：AvatarService 的语义事件契约（speaking / gesture / emotion / report / on），
 *   记录口型包络序列（E1 视图侧的嘴型驱动）；
 * - `createWriteFileTool` + `installDangerToolGuardrail`：危险工具与 GuardrailsPlugin 的危险工具分支（E5）。
 */

import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  LLMProvider,
  LLMRegistry,
  PluginContext,
  ToolDefinition,
} from '@nomi-ai/bundle-ig-base';
import type { AvatarEvent, AvatarService } from '@nomi-ai/bundle-ig-mascot/seams';

export interface FakeLLM extends LLMProvider {
  chatCalls: ChatRequest[];
  streamCalls: ChatRequest[];
  aborted: string[];
  /** 允许 test 用例覆盖某次 chat 的返回内容（默认 `ok`） */
  nextContent?: string;
}

export function createFakeLLM(id = 'fake'): FakeLLM {
  const chatCalls: ChatRequest[] = [];
  const streamCalls: ChatRequest[] = [];
  const aborted: string[] = [];
  const provider: FakeLLM = {
    id,
    chatCalls,
    streamCalls,
    aborted,
    nextContent: undefined,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      chatCalls.push(req);
      return {
        reqId: req.reqId,
        provider: id,
        model: req.model,
        content: provider.nextContent ?? 'ok',
        finishReason: 'stop',
      };
    },
    stream(req: ChatRequest): AsyncIterable<ChatChunk> {
      streamCalls.push(req);
      return (async function* () {
        yield { type: 'delta', content: 'hel' } as ChatChunk;
        yield { type: 'delta', content: 'lo' } as ChatChunk;
        yield { type: 'done', finishReason: 'stop' } as ChatChunk;
      })();
    },
    abort(reqId: string): void {
      aborted.push(reqId);
    },
  };
  return provider;
}

export function createFakeLLMRegistry(...providers: LLMProvider[]): LLMRegistry {
  const map = new Map<string, LLMProvider>();
  for (const p of providers) map.set(p.id, p);
  return {
    register: (p) => {
      map.set(p.id, p);
    },
    get: (id) => map.get(id),
    list: () => [...map.values()],
  };
}

/* ----------------------------------------------------------- *
 * Avatar service —— 记录语义事件（speaking / gesture / emotion） *
 * ----------------------------------------------------------- */

export interface FakeAvatarService extends AvatarService {
  speakingCalls: number[];
  gestureCalls: string[];
  emotionCalls: Array<{ name: string; weight?: number }>;
  activityCalls: string[];
}

export function createFakeAvatarService(): FakeAvatarService {
  const speakingCalls: number[] = [];
  const gestureCalls: string[] = [];
  const emotionCalls: Array<{ name: string; weight?: number }> = [];
  const activityCalls: string[] = [];
  const listeners = new Map<AvatarEvent, Set<(p: unknown) => void>>();
  const fire = (evt: AvatarEvent, payload: unknown) =>
    listeners.get(evt)?.forEach((fn) => fn(payload));

  const svc: FakeAvatarService = {
    speakingCalls,
    gestureCalls,
    emotionCalls,
    activityCalls,
    async gesture(name) {
      gestureCalls.push(name);
    },
    async emotion(name, weight) {
      emotionCalls.push(weight === undefined ? { name } : { name, weight });
    },
    async activity(name) {
      activityCalls.push(name);
    },
    speaking(level) {
      speakingCalls.push(level);
    },
    report(event) {
      const { type, ...rest } = event;
      fire(type, { ...rest, at: Date.now() });
    },
    scene() {
      return null;
    },
    on(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, new Set());
      const set = listeners.get(evt)!;
      set.add(fn as (p: unknown) => void);
      return () => set.delete(fn as (p: unknown) => void);
    },
    attachHost() {
      return () => undefined;
    },
    hasHost() {
      return true;
    },
  };
  return svc;
}

/* -------------------------------------------------------------- *
 * write_file —— 危险工具冒烟：默认拒绝执行，须由 GuardrailsPlugin *
 * 逻辑等价物在 `installDangerToolGuardrail(ctx)` 中完成拒绝 & 触发  *
 * `tool/confirm-required`；execute 记录调用次数供断言校验。       *
 * -------------------------------------------------------------- */

export interface WriteFileArgs {
  path: string;
  content: string;
}
export interface WriteFileResult {
  written: number;
  path: string;
}
export interface WriteFileTool extends ToolDefinition<WriteFileArgs, WriteFileResult> {
  executions: WriteFileArgs[];
}

export function createWriteFileTool(): WriteFileTool {
  const executions: WriteFileArgs[] = [];
  const tool: WriteFileTool = {
    name: 'write_file',
    description: 'Write text content to a file on the local disk (DANGEROUS)',
    dangerous: true,
    input: { type: 'write-file-input' },
    executions,
    async execute(input: WriteFileArgs): Promise<WriteFileResult> {
      executions.push(input);
      return { written: input.content.length, path: input.path };
    },
  };
  return tool;
}

/** 被假防线拒绝的一次工具调用 */
export interface ToolDenial {
  tool: string;
  reqId?: string;
  code: string;
  reason: string;
}

/**
 * 复刻 [GuardrailsPlugin](../../apps/desktop-electron/internal/bundle-ig-base/src/plugins/GuardrailsPlugin.ts)
 * 的 danger-tool 分支，装在真实内核的插件宿主里（`aiPluginsAfter`）：命中 dangerTools 且
 * `confirmed !== true` 时发 `tool/confirm-required`（AIClient 桥接成契约事件 `ai.tool.confirmRequired`），
 * 记一条拒绝并 reject。插件宿主吞掉 hook 的 reject（只记 warn），所以拒绝结果从 `denials` 读。
 */
export function installDangerToolGuardrail(
  ctx: Pick<PluginContext, 'on' | 'emit'>,
  dangerTools: string[],
): { off: () => void; denials: ToolDenial[] } {
  const set = new Set(dangerTools);
  const denials: ToolDenial[] = [];
  const off = ctx.on<{ tool: string; args: unknown; confirmed?: boolean; reqId?: string }>(
    'tools/pre-execute',
    async (hookCtx) => {
      const { tool, args, confirmed, reqId } = hookCtx.payload;
      if (set.has(tool) && confirmed !== true) {
        ctx.emit('tool/confirm-required', { tool, args, reqId });
        const reason = 'danger tool requires user confirm';
        denials.push({ tool, ...(reqId ? { reqId } : {}), code: 'E_TOOL_DENIED', reason });
        hookCtx.reject(reason, 'E_TOOL_DENIED');
      }
    },
  );
  return { off, denials };
}
