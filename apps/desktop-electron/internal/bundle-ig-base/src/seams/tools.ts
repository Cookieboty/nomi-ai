import type { ToolDefinition } from '../types/common';
import { defineService } from '../types/plugin';

export interface ToolRegistry {
  register<TInput = unknown, TOutput = unknown>(tool: ToolDefinition<TInput, TOutput>): void;
  get(name: string): ToolDefinition | undefined;
  list(): ToolDefinition[];
  /** Remove a previously registered tool (e.g. MCP server disconnect). */
  unregister?(name: string): boolean;
}

export const ToolRegistryKey = defineService<ToolRegistry>('ctx.tools');
