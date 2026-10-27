import { describe, expect, it } from 'vitest';

import {
  IMAGE_MODEL_SPECS,
  chatToolFields,
  clampOnChange,
  clampParams,
  getImageSpec,
  initialParams,
  layoutProperties,
  migrateParams,
  resolveConstraints,
  schemaDefaults,
  validateSpec,
  type MediaModelSpec,
} from '../src/media';

const gpt = getImageSpec('gpt-image-1')!;
const seedream = getImageSpec('seedream-4')!;
const gemini = getImageSpec('gemini-2.5-flash-image')!;

describe('随包 spec 合法性', () => {
  it('至少 4 个图片模型，且全部通过 validateSpec', () => {
    expect(IMAGE_MODEL_SPECS.filter((s) => s.kind === 'image').length).toBeGreaterThanOrEqual(4);
    for (const s of IMAGE_MODEL_SPECS) expect(validateSpec(s), s.id).toEqual([]);
  });

  it('id 唯一', () => {
    const ids = IMAGE_MODEL_SPECS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('validateSpec 能发现写错的约束', () => {
    const bad: MediaModelSpec = {
      ...gpt,
      schemaVersion: 0,
      paramsSchema: {
        type: 'object',
        properties: {
          a: {
            type: 'string',
            enum: ['x'],
            default: 'y',
            'x-ui': { control: 'chips', label: 'a', order: 1 },
          },
          b: {
            type: 'integer',
            minimum: 5,
            maximum: 1,
            'x-ui': { control: 'slider', label: 'b', order: 2 },
          },
          c: { type: 'string', 'x-ui': { control: 'select', label: 'c', order: 3 } },
        },
        allOf: [
          {
            if: { properties: { zz: { const: 1 } } },
            then: { properties: { b: { maximum: 99 } } },
          },
          {
            if: { properties: { a: { const: 'x' } } },
            then: { properties: { a: { enum: ['q'] } } },
          },
        ],
      },
    };
    const errs = validateSpec(bad);
    expect(errs).toEqual(
      expect.arrayContaining([
        'schemaVersion must be a positive integer',
        'a: default not in enum',
        'b: minimum > maximum',
        'c: select needs enum',
        'allOf[0]: unknown guard zz',
        'allOf[1]: a enum must narrow',
      ]),
    );
  });
});

describe('resolveConstraints / layoutProperties', () => {
  it('条件命中时收紧 enum 并隐藏字段', () => {
    const r = resolveConstraints(gpt.paramsSchema, {
      background: 'transparent',
      output_format: 'png',
    });
    expect(r.props.output_format!.enum).toEqual(['png', 'webp']);
    expect(r.hidden.has('output_compression')).toBe(true);
    // 原 schema 不被修改
    expect(gpt.paramsSchema.properties.output_format!.enum).toEqual(['png', 'jpeg', 'webp']);
  });

  it('布局按 order 排序、分基础 / 高级，surface 过滤', () => {
    const l = layoutProperties(gpt, schemaDefaults(gpt));
    expect(l.basic.map((f) => f.key)).toEqual(['aspect_ratio', 'n', 'quality']);
    expect(l.advanced.map((f) => f.key)).toEqual(['background', 'output_format']);
    expect(l.hidden).toEqual(['output_compression']);
    const chat = layoutProperties(seedream, schemaDefaults(seedream), 'chat');
    expect(chat.basic.map((f) => f.key)).toEqual(['resolution', 'aspect_ratio', 'n']);
    expect(chat.advanced).toEqual([]);
  });
});

describe('clampParams / clampOnChange', () => {
  it('条件上限：4K 时张数夹到 4', () => {
    const r = clampOnChange(seedream, { resolution: '2K', n: 10 }, 'resolution', '4K');
    expect(r.params.n).toBe(4);
    expect(r.notes).toContainEqual({ key: 'n', kind: 'max', value: 4 });
  });

  it('enum 不合法回落默认；透明背景下 jpeg 回落 png', () => {
    expect(clampParams(gpt, { quality: 'ultra' }).params.quality).toBe('medium');
    const r = clampOnChange(gpt, { output_format: 'jpeg' }, 'background', 'transparent');
    expect(r.params.output_format).toBe('png');
  });

  it('未知字段丢弃、类型纠正、数值下限', () => {
    const r = clampParams(gpt, { foo: 1, n: '3', output_compression: -5 } as never);
    expect(r.params).toEqual({ n: 3, output_compression: 0 });
    expect(r.notes.map((n) => n.kind)).toEqual(expect.arrayContaining(['dropped', 'min']));
    expect(clampParams(gemini, { seed: 'abc' }).params.seed).toBeUndefined();
  });

  it('initialParams：schema 默认 ← 我的默认 ← 覆盖', () => {
    expect(initialParams(gpt, { quality: 'high' }, { n: 2 })).toMatchObject({
      aspect_ratio: '1:1',
      quality: 'high',
      n: 2,
    });
  });
});

describe('migrateParams', () => {
  it('跨模型保留同名字段、丢弃其余，并按目标约束夹取', () => {
    const r = migrateParams(seedream, { aspect_ratio: '3:2', n: 4, quality: 'high' });
    expect(r.kept.sort()).toEqual(['aspect_ratio', 'n']);
    expect(r.dropped).toEqual(['quality']);
    expect(r.params.aspect_ratio).toBe('1:1'); // 3:2 不在 seedream 枚举里 → 回落默认
    expect(r.params.n).toBe(4);
    expect(r.params.resolution).toBe('2K');
  });

  it('同模型 schema 升级：旧参数里被删除的字段不残留', () => {
    const v2: MediaModelSpec = {
      ...gemini,
      schemaVersion: 2,
      paramsSchema: {
        type: 'object',
        properties: { aspect_ratio: gemini.paramsSchema.properties.aspect_ratio! },
      },
    };
    const r = migrateParams(v2, { aspect_ratio: '16:9', temperature: 1.5 });
    expect(r.params).toEqual({ aspect_ratio: '16:9' });
    expect(r.dropped).toEqual(['temperature']);
  });
});

describe('chatToolFields', () => {
  it('取所有 spec 中 surface 含 chat 的字段并集', () => {
    const f = chatToolFields(IMAGE_MODEL_SPECS);
    expect(Object.keys(f).sort()).toEqual(['aspect_ratio', 'n', 'quality', 'resolution']);
    expect(f.aspect_ratio!.options).toEqual(expect.arrayContaining(['1:1', '16:9', '3:2', 'auto']));
  });
});
