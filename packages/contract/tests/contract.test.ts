import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  canSubscribe,
  createClient,
  defineContract,
  getProcedure,
  isCompatible,
  type AnyContract,
} from '../src';
import { createInProcessTransport } from '../src/testing';

import { testContract } from './fixtures';

const q = { kind: 'query' as const, input: z.void(), output: z.string() };

describe('defineContract', () => {
  it('returns a frozen contract with defaults', () => {
    const c = defineContract({ version: { major: 2, minor: 0 }, procedures: { 'a.b': q } });
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.procedures)).toBe(true);
    expect(c.events).toEqual({});
    expect(c.errors).toEqual([]);
    expect(getProcedure(c, 'a.b')).toBe(q);
    expect(getProcedure(c, 'toString')).toBeUndefined();
  });

  it.each([
    ['bad name', { 'a..b': q }, /invalid procedure name/],
    ['reserved meta', { 'meta.version': q }, /reserved/],
    ['reserved on', { on: q }, /reserved/],
    ['reserved $', { $connect: q }, /reserved|invalid/],
    ['namespace collision', { a: q, 'a.b': q }, /conflicts/],
    ['missing input', { a: { kind: 'query', output: z.string() } }, /input schema/],
    ['missing output', { a: { kind: 'query', input: z.void() } }, /output schema/],
    ['missing chunk', { a: { kind: 'stream', input: z.void() } }, /chunk schema/],
    ['bad kind', { a: { kind: 'sync-return', input: z.void(), output: z.void() } }, /kind/],
    ['unknown surface', { a: { ...q, surfaces: ['desktop'] } }, /unknown surface/],
  ])('rejects %s', (_label, procedures, message) => {
    expect(() =>
      defineContract({ version: { major: 1, minor: 0 }, procedures: procedures as never }),
    ).toThrow(message);
  });

  it('validates version, events and error codes', () => {
    expect(() => defineContract({ version: { major: 1.5, minor: 0 }, procedures: {} })).toThrow(
      /version/,
    );
    expect(() =>
      defineContract({
        version: { major: 1, minor: 0 },
        procedures: {},
        events: { 'bad name': z.string() },
      }),
    ).toThrow(/event name/);
    expect(() =>
      defineContract({ version: { major: 1, minor: 0 }, procedures: {}, errors: ['ABORTED'] }),
    ).toThrow(/built in/);
    expect(() =>
      defineContract({ version: { major: 1, minor: 0 }, procedures: {}, errors: ['lower'] }),
    ).toThrow(/UPPER_SNAKE_CASE/);
  });

  it('validates event surfaces and exposes them through canSubscribe', () => {
    const v = { major: 1, minor: 0 };
    const events = { 'a.b': z.string() };
    expect(() =>
      defineContract({
        version: v,
        procedures: {},
        events,
        eventSurfaces: { 'x.y': ['chat'] } as never,
      }),
    ).toThrow(/unknown event/);
    expect(() =>
      defineContract({ version: v, procedures: {}, events, eventSurfaces: { 'a.b': [] } }),
    ).toThrow(/at least one/);
    expect(() =>
      defineContract({
        version: v,
        procedures: {},
        events,
        eventSurfaces: { 'a.b': ['nope'] as never },
      }),
    ).toThrow(/unknown surface/);
    const c = defineContract({
      version: v,
      procedures: {},
      events,
      eventSurfaces: { 'a.b': ['chat'] },
    });
    expect(canSubscribe(c, 'a.b', 'chat')).toBe(true);
    expect(canSubscribe(c, 'a.b', 'mascot')).toBe(false);
    expect(canSubscribe(c, 'other', 'mascot')).toBe(true);
    expect(Object.isFrozen(c.eventSurfaces)).toBe(true);
  });

  it('keeps flags from the definition', () => {
    expect(testContract.procedures['tools.confirm'].dangerous).toBe(true);
    expect(testContract.procedures['settings.reset'].surfaces).toEqual(['settings', 'test']);
    expect(testContract.errors).toEqual(['SESSION_NOT_FOUND']);
  });

  it('treats only major as breaking', () => {
    expect(isCompatible({ major: 1, minor: 0 }, { major: 1, minor: 9 })).toBe(true);
    expect(isCompatible({ major: 1, minor: 0 }, { major: 2, minor: 0 })).toBe(false);
  });
});

describe('reserved identifiers / prototype pollution', () => {
  it.each(['__proto__', 'constructor', 'prototype', 'then'])(
    "rejects '%s' in any segment of procedure and event names",
    (seg) => {
      for (const name of [seg, `a.${seg}`, `a.${seg}.b`, `x.y.${seg}`]) {
        const procedures = Object.defineProperty({}, name, { value: q, enumerable: true });
        expect(() =>
          defineContract({ version: { major: 1, minor: 0 }, procedures: procedures as never }),
        ).toThrow(/reserved/);
        const events = Object.defineProperty({}, name, { value: z.string(), enumerable: true });
        expect(() =>
          defineContract({ version: { major: 1, minor: 0 }, procedures: {}, events }),
        ).toThrow(/reserved/);
      }
    },
  );

  it('createClient refuses reserved segments even when defineContract is bypassed', () => {
    const procedures = JSON.parse('{"a.__proto__.polluted": 1, "constructor.x": 1}') as Record<
      string,
      unknown
    >;
    for (const key of Object.keys(procedures)) procedures[key] = q;
    const forged = { version: { major: 1, minor: 0 }, procedures, events: {}, errors: [] };
    const { client } = createInProcessTransport();
    expect(() => createClient(forged as unknown as AnyContract, client)).toThrow(/reserved/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('builds nested nodes without touching Object.prototype members', () => {
    const c = defineContract({
      version: { major: 1, minor: 0 },
      procedures: { 'toString.x': q, 'hasOwnProperty.y': q, valueOf: q },
    });
    const { client } = createInProcessTransport();
    const api = createClient(c, client, { handshake: 'off' });
    const own = (k: string) =>
      Object.getOwnPropertyDescriptor(api, k)?.value as Record<string, unknown>;
    expect(typeof own('toString').x).toBe('function');
    expect(typeof own('hasOwnProperty').y).toBe('function');
    expect(typeof own('valueOf')).toBe('function');
    expect(Object.getPrototypeOf(own('toString'))).toBeNull();
    expect((Object.prototype.toString as unknown as Record<string, unknown>).x).toBeUndefined();
    expect(
      (Object.prototype.hasOwnProperty as unknown as Record<string, unknown>).y,
    ).toBeUndefined();
    expect(Object.isFrozen(own('toString'))).toBe(true);
  });
});

describe('package boundary (§11.1)', () => {
  const files: string[] = [];
  const collect = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) collect(p);
      else if (p.endsWith('.ts')) files.push(p);
    }
  };
  collect(fileURLToPath(new URL('../src', import.meta.url)));

  it('never imports electron or node built-ins', () => {
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      expect(src, file).not.toMatch(/from\s+['"]electron['"]/);
      expect(src, file).not.toMatch(/require\(\s*['"]electron['"]\s*\)/);
      expect(src, file).not.toMatch(/from\s+['"]node:/);
    }
  });
});
