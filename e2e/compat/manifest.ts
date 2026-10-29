/**
 * 契约兼容冒烟用的清单（docs/design/core-host-decoupling.md §4.3、§11.3「契约兼容」）：
 * 把契约里每个过程 / 事件的 kind、surfaces、dangerous 与 zod 结构（JSON Schema）写成可比较、可提交的数据。
 * `baseline/v<major>.json` 是这个 major 第一次发布时视图看到的契约，「旧视图」按它重建。
 */
import type { AnyContract } from '@nomi-ai/contract';
import { z } from 'zod';

export type JsonSchema = Record<string, unknown>;

export interface ProcedureEntry {
  kind: string;
  surfaces: string[] | null;
  dangerous: boolean;
  input: JsonSchema;
  output: JsonSchema | null;
  chunk: JsonSchema | null;
}

export interface ContractManifest {
  version: { major: number; minor: number };
  procedures: Record<string, ProcedureEntry>;
  events: Record<string, { payload: JsonSchema; surfaces: string[] | null }>;
}

type Def = {
  kind: string;
  surfaces?: readonly string[];
  dangerous?: boolean | string;
  input: z.ZodType;
  output?: z.ZodType;
  chunk?: z.ZodType;
};

const toJson = (schema: z.ZodType, io: 'input' | 'output'): JsonSchema => {
  const out = z.toJSONSchema(schema, { io, unrepresentable: 'any', cycles: 'ref' }) as JsonSchema;
  delete out.$schema;
  return out;
};

const sorted = <T>(o: Record<string, T>): Record<string, T> =>
  Object.fromEntries(
    Object.keys(o)
      .sort()
      .map((k) => [k, o[k]!]),
  );

export function manifestOf(contract: AnyContract): ContractManifest {
  const procedures: Record<string, ProcedureEntry> = {};
  for (const [name, raw] of Object.entries(contract.procedures)) {
    const d = raw as Def;
    procedures[name] = {
      kind: d.kind,
      surfaces: d.surfaces ? [...d.surfaces].sort() : null,
      dangerous: Boolean(d.dangerous),
      // 视图发的是 input 侧，收的是 output 侧
      input: toJson(d.input, 'input'),
      output: d.output ? toJson(d.output, 'output') : null,
      chunk: d.chunk ? toJson(d.chunk, 'output') : null,
    };
  }
  const events: ContractManifest['events'] = {};
  for (const [name, schema] of Object.entries(contract.events)) {
    const s = contract.eventSurfaces[name];
    events[name] = {
      payload: toJson(schema as z.ZodType, 'output'),
      surfaces: s ? [...s].sort() : null,
    };
  }
  return {
    version: { ...contract.version },
    procedures: sorted(procedures),
    events: sorted(events),
  };
}
