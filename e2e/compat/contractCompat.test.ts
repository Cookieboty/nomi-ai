/**
 * 契约兼容冒烟（docs/design/core-host-decoupling.md §4.3、§11.3「契约兼容」）：契约 major 不变时，旧视图对新内核跑一遍。
 *
 * 「旧视图」= `baseline/v<major>.json`：这个 major 第一次发布（2.0.5，契约 2.2）时视图编进去的契约，
 * 按清单里的 JSON Schema 重建成 zod 契约，用真实的 `createClient`（自动握手、入参 / 出参 / 事件校验）
 * 连 `@nomi-ai/host-node` 上的真实内核。全程不碰网络与时钟，结果确定。
 *
 * 1. 静态：旧清单里的过程 / 事件在新契约里都还在，kind 与 dangerous 不变，surfaces 只增不减；
 *    入参只能新增可选字段，出参与事件不能删字段、不能把必填改成可选（§4.3 minor「只增不删」）。
 * 2. 运行：旧客户端握手通过（major 不一致则 VERSION_MISMATCH）；视图启动时读的那批过程按旧出参 schema 解析通过；
 *    一次 mutation 触发的事件按旧事件 schema 送达。
 *
 * 契约升 major 时才换基线：`CONTRACT_COMPAT_UPDATE=1 pnpm test:contract-compat` 写出新的 `baseline/v<major>.json`。
 */
import fs from 'node:fs';
import path from 'node:path';

import { createClient, defineContract, isContractError, type AnyContract } from '@nomi-ai/contract';
import { appContract } from '@nomi-ai/contract/app';
import { startHeadlessCore, type HeadlessCore } from '@nomi-ai/host-node/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { manifestOf, type ContractManifest, type JsonSchema } from './manifest';

const current = manifestOf(appContract);
const baselineFile = path.join(__dirname, 'baseline', `v${current.version.major}.json`);

if (process.env.CONTRACT_COMPAT_UPDATE === '1') {
  fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
  fs.writeFileSync(baselineFile, `${JSON.stringify(current, null, 2)}\n`);
}

const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8')) as ContractManifest;

/** 视图启动时读的过程（对话窗口身份，无入参、不出网） */
const STARTUP_READS = [
  'theme.get',
  'locale.get',
  'locale.dict',
  'startup.get',
  'onboarding.get',
  'persona.get',
  'character.getActivePack',
  'providers.state',
  'providers.meta',
  'gateway.state',
  'voice.state',
  'desktop.state',
  'tts.getConfig',
  'usage.state',
  'mem.state',
  'kb.state',
  'harness.state',
  'sched.state',
  'quality.getSettings',
  'window.platform',
  'ai.sessions.list',
  'ai.tools.list',
] as const;

type Obj = { properties?: Record<string, unknown>; required?: string[] };
const props = (s: JsonSchema | null): string[] => Object.keys((s as Obj | null)?.properties ?? {});
const required = (s: JsonSchema | null): string[] => (s as Obj | null)?.required ?? [];
const missing = (need: string[], have: string[]): string[] => need.filter((k) => !have.includes(k));

/** 旧视图的 zod 对象会丢掉不认识的字段：重建时去掉 additionalProperties: false，新增字段不算破坏 */
function lenient(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(lenient);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'additionalProperties' && v === false) continue;
    out[k] = lenient(v);
  }
  return out;
}
const fromJson = (s: JsonSchema): z.ZodType =>
  z.fromJSONSchema(lenient(s) as Parameters<typeof z.fromJSONSchema>[0]) as z.ZodType;

/** 按基线清单重建旧视图编进去的契约 */
function oldViewContract(m: ContractManifest): AnyContract {
  const procedures: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(m.procedures)) {
    procedures[name] = {
      kind: p.kind,
      input: fromJson(p.input),
      ...(p.output ? { output: fromJson(p.output) } : {}),
      ...(p.chunk ? { chunk: fromJson(p.chunk) } : {}),
      ...(p.surfaces ? { surfaces: p.surfaces } : {}),
      ...(p.dangerous ? { dangerous: true } : {}),
    };
  }
  const events = Object.fromEntries(
    Object.entries(m.events).map(([name, e]) => [name, fromJson(e.payload)]),
  );
  return defineContract({
    version: m.version,
    procedures,
    events,
    errors: [],
  } as unknown as Parameters<typeof defineContract>[0]) as unknown as AnyContract;
}

describe('契约兼容：旧视图 × 新内核', () => {
  it('基线与当前契约同一个 major，minor 不回退', () => {
    expect(current.version.major).toBe(baseline.version.major);
    expect(current.version.minor).toBeGreaterThanOrEqual(baseline.version.minor);
  });

  it('过程：还在、kind / dangerous 不变、surfaces 只增、入参只加可选、出参不删字段', () => {
    const problems: string[] = [];
    for (const [name, old] of Object.entries(baseline.procedures)) {
      const now = current.procedures[name];
      if (!now) {
        problems.push(`${name}: removed`);
        continue;
      }
      if (now.kind !== old.kind) problems.push(`${name}: kind ${old.kind} -> ${now.kind}`);
      if (now.dangerous !== old.dangerous) problems.push(`${name}: dangerous changed`);
      if (now.surfaces && (!old.surfaces || missing(old.surfaces, now.surfaces).length))
        problems.push(`${name}: surfaces narrowed to ${now.surfaces.join('|')}`);
      const newRequired = missing(required(now.input), required(old.input));
      if (newRequired.length) problems.push(`${name}: new required input ${newRequired}`);
      const dropped = missing(props(old.input), props(now.input));
      if (dropped.length) problems.push(`${name}: input fields removed ${dropped}`);
      for (const side of ['output', 'chunk'] as const) {
        const lost = missing(required(old[side]), required(now[side]));
        if (lost.length) problems.push(`${name}: ${side} no longer guarantees ${lost}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('事件：还在、payload 必填字段不减、订阅白名单只增', () => {
    const problems: string[] = [];
    for (const [name, old] of Object.entries(baseline.events)) {
      const now = current.events[name];
      if (!now) {
        problems.push(`${name}: removed`);
        continue;
      }
      const lost = missing(required(old.payload), required(now.payload));
      if (lost.length) problems.push(`${name}: payload no longer guarantees ${lost}`);
      if (now.surfaces && (!old.surfaces || missing(old.surfaces, now.surfaces).length))
        problems.push(`${name}: surfaces narrowed to ${now.surfaces.join('|')}`);
    }
    expect(problems).toEqual([]);
  });

  describe('运行：旧客户端连 host-node 上的新内核', () => {
    let h: HeadlessCore;
    const oldContract = oldViewContract(baseline);

    beforeAll(async () => {
      h = await startHeadlessCore({ logLevel: 'warn' });
    });
    afterAll(async () => {
      await h?.stop();
    });

    const oldView = () => {
      const { transport } = h.connect();
      return createClient(oldContract, transport, { handshake: 'auto' });
    };

    it('握手：同 major 通过，major 不一致直接 VERSION_MISMATCH', async () => {
      const info = await oldView().$connect();
      expect(info.version).toEqual(current.version);

      const { transport } = h.connect();
      const future = defineContract({
        version: { major: baseline.version.major + 1, minor: 0 },
        procedures: {},
        events: {},
        errors: [],
      });
      const err = await createClient(future, transport)
        .$connect()
        .catch((e: unknown) => e);
      expect(isContractError(err, 'VERSION_MISMATCH')).toBe(true);
    });

    it.each(STARTUP_READS)('%s 按旧出参 schema 解析', async (name) => {
      expect(baseline.procedures[name], `${name} 不在基线里`).toBeDefined();
      const api = oldView() as unknown as Record<string, Record<string, (i?: unknown) => unknown>>;
      const [ns, ...rest] = name.split('.');
      let fn: unknown = api[ns!];
      for (const seg of rest) fn = (fn as Record<string, unknown>)[seg];
      await expect((fn as () => Promise<unknown>)()).resolves.toBeDefined();
    });

    it('mutation 的结果与它触发的事件按旧 schema 送达', async () => {
      const api = oldView() as unknown as {
        theme: { set(i: { pref: string }): Promise<{ pref: string }> };
        on(event: string, fn: (d: unknown) => void): () => void;
      };
      const seen: unknown[] = [];
      const off = api.on('theme.changed', (d) => seen.push(d));
      await (api as unknown as { $connect(): Promise<unknown> }).$connect();
      expect((await api.theme.set({ pref: 'graphite' })).pref).toBe('graphite');
      await expect.poll(() => seen.length).toBeGreaterThan(0);
      off();
    });
  });
});
