/**
 * ToolsFacade —— 列出 / 注册 / 启停 / 二次确认。
 *
 * 关键点：
 * - `list()` 会把内部的 zod schema 转换为**可序列化的粗略 JSON Schema**（保守：只标 name + description）
 *   避免在 P5 就绑死 zod-to-json-schema 依赖；P8 迁移时如需完整 schema 再引入即可。
 * - `confirm(reqId, ok)` 通过 插件事件 `tool/confirm-required` 的**逆向**通道发送——本
 *   Facade 只负责把决策 emit 出去，真正等待方在 guardrails 中间件（P2 GuardrailsPlugin）。
 */

import { ToolRegistryKey, type ToolDefinition } from '@nomi-ai/bundle-ig-base';

import type { SdkContext } from '../di/SdkContext';
import { AIClientError, ErrorCodes } from '../errors';
import type { ToolSpec } from '../types/ToolSpec';

export interface ToolConfirmDecisionPayload {
  reqId: string;
  ok: boolean;
  reason?: string;
}

export interface ToolsFacade {
  list(): ToolSpec[];
  register<TIn = unknown, TOut = unknown>(tool: ToolDefinition<TIn, TOut>): void;
  setEnabled(name: string, enabled: boolean): void;
  confirm(reqId: string, ok: boolean, reason?: string): void;
}

export function createToolsFacade(ctx: SdkContext): ToolsFacade {
  const enabled = new Map<string, boolean>();

  const requireRegistry = () => {
    const reg = ctx.inject(ToolRegistryKey);
    if (!reg) {
      throw new AIClientError(
        ErrorCodes.SEAM_NOT_INJECTED,
        'ctx.tools 未注入；请确认已加载 bundle-ig-base',
      );
    }
    return reg;
  };

  return {
    list() {
      const reg = ctx.inject(ToolRegistryKey);
      if (!reg) return [];
      return reg.list().map<ToolSpec>((t) => ({
        name: t.name,
        description: t.description,
        parametersJsonSchema: {},
        dangerous: t.dangerous,
        enabled: enabled.get(t.name) ?? true,
      }));
    },
    register(tool) {
      const reg = requireRegistry();
      reg.register(tool);
    },
    setEnabled(name, e) {
      const reg = ctx.inject(ToolRegistryKey);
      if (!reg || !reg.get(name)) {
        throw new AIClientError(ErrorCodes.TOOL_NOT_FOUND, `tool '${name}' 未注册`);
      }
      enabled.set(name, e);
    },
    confirm(reqId, ok, reason) {
      if (!reqId) {
        throw new AIClientError(ErrorCodes.TOOL_CONFIRM_INVALID, 'confirm 必须提供 reqId');
      }
      const payload: ToolConfirmDecisionPayload = { reqId, ok, reason };
      ctx.emit('tools/wrap', payload);
    },
  };
}
