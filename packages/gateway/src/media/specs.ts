/**
 * 随版本打包的图片模型 schema（P0）。改字段语义时把该模型的 schemaVersion +1。
 * 对话界面（surface 含 chat）统一用 aspect_ratio / n / quality / resolution 这几个字段名，
 * 便于 generate_image 工具取并集；各家的尺寸写法由协议适配层合成。
 */
import type { MediaModelSpec } from './types';

export const MEDIA_SCHEMA_VERSION = 1;

export const IMAGE_MODEL_SPECS: MediaModelSpec[] = [
  {
    id: 'gpt-image-1',
    name: 'GPT Image 1',
    kind: 'image',
    capabilities: ['t2i', 'i2i', 'edit'],
    schemaVersion: 1,
    'x-task': { mode: 'sync', timeoutMs: 180_000 },
    'x-media': {
      image: { max: 4, roles: ['reference_image'], label: 'ui.media.ref-or-edit-image' },
    },
    paramsSchema: {
      type: 'object',
      properties: {
        aspect_ratio: {
          type: 'string',
          enum: ['1:1', '3:2', '2:3', 'auto'],
          default: '1:1',
          'x-ui': {
            control: 'chips',
            label: 'ui.media.param-aspect-ratio',
            order: 1,
            surface: ['studio', 'chat'],
            optionLabels: { auto: 'ui.foundation.auto' },
          },
        },
        n: {
          type: 'integer',
          minimum: 1,
          maximum: 4,
          default: 1,
          'x-ui': {
            control: 'stepper',
            label: 'ui.media.param-count',
            order: 2,
            surface: ['studio', 'chat'],
          },
        },
        quality: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          default: 'medium',
          'x-ui': {
            control: 'select',
            label: 'ui.media.param-quality',
            order: 3,
            surface: ['studio', 'chat'],
            optionLabels: {
              low: 'ui.chat-settings.low',
              medium: 'ui.chat-settings.medium',
              high: 'ui.chat-settings.high',
            },
          },
        },
        background: {
          type: 'string',
          enum: ['auto', 'transparent', 'opaque'],
          default: 'auto',
          'x-ui': {
            control: 'chips',
            label: 'ui.media.param-background',
            order: 10,
            advanced: true,
            optionLabels: {
              auto: 'ui.foundation.auto',
              transparent: 'ui.media.opt-transparent',
              opaque: 'ui.media.opt-opaque',
            },
          },
        },
        output_format: {
          type: 'string',
          enum: ['png', 'jpeg', 'webp'],
          default: 'png',
          'x-ui': {
            control: 'select',
            label: 'ui.media.param-output-format',
            order: 11,
            advanced: true,
          },
        },
        output_compression: {
          type: 'integer',
          minimum: 0,
          maximum: 100,
          default: 80,
          'x-ui': {
            control: 'slider',
            label: 'ui.media.param-compression',
            order: 12,
            advanced: true,
            step: 5,
          },
        },
      },
      allOf: [
        {
          if: { properties: { background: { const: 'transparent' } } },
          then: { properties: { output_format: { enum: ['png', 'webp'] } } },
        },
        {
          if: { properties: { output_format: { const: 'png' } } },
          then: { 'x-hidden': ['output_compression'] },
        },
      ],
    },
  },
  {
    id: 'gemini-2.5-flash-image',
    name: 'Gemini 2.5 Flash Image',
    kind: 'image',
    capabilities: ['t2i', 'i2i'],
    schemaVersion: 1,
    'x-task': { mode: 'sync', timeoutMs: 120_000 },
    'x-media': { image: { max: 3, roles: ['reference_image'], label: 'ui.media.ref-image' } },
    paramsSchema: {
      type: 'object',
      properties: {
        aspect_ratio: {
          type: 'string',
          enum: ['1:1', '16:9', '9:16', '4:3', '3:4'],
          default: '1:1',
          'x-ui': {
            control: 'chips',
            label: 'ui.media.param-aspect-ratio',
            order: 1,
            surface: ['studio', 'chat'],
          },
        },
        temperature: {
          type: 'number',
          minimum: 0,
          maximum: 2,
          default: 1,
          'x-ui': {
            control: 'slider',
            label: 'ui.media.param-temperature',
            order: 5,
            step: 0.1,
            advanced: true,
          },
        },
        seed: {
          type: 'integer',
          minimum: 0,
          maximum: 2147483647,
          'x-ui': { control: 'text', label: 'ui.media.param-seed', order: 6, advanced: true },
        },
      },
    },
  },
  {
    id: 'seedream-4',
    name: 'Seedream 4.0',
    kind: 'image',
    capabilities: ['t2i', 'i2i'],
    schemaVersion: 1,
    'x-task': { mode: 'sync', timeoutMs: 180_000 },
    'x-media': { image: { max: 10, roles: ['reference_image'], label: 'ui.media.ref-image' } },
    paramsSchema: {
      type: 'object',
      properties: {
        resolution: {
          type: 'string',
          enum: ['1K', '2K', '4K'],
          default: '2K',
          'x-ui': {
            control: 'chips',
            label: 'ui.media.param-resolution',
            order: 1,
            surface: ['studio', 'chat'],
          },
        },
        aspect_ratio: {
          type: 'string',
          enum: ['1:1', '4:3', '3:4', '16:9', '9:16'],
          default: '1:1',
          'x-ui': {
            control: 'chips',
            label: 'ui.media.param-aspect-ratio',
            order: 2,
            surface: ['studio', 'chat'],
          },
        },
        n: {
          type: 'integer',
          minimum: 1,
          maximum: 15,
          default: 1,
          'x-ui': {
            control: 'stepper',
            label: 'ui.media.param-batch-count',
            order: 3,
            surface: ['studio', 'chat'],
          },
        },
        watermark: {
          type: 'boolean',
          default: false,
          'x-ui': {
            control: 'switch',
            label: 'ui.media.param-watermark',
            order: 10,
            advanced: true,
          },
        },
      },
      allOf: [
        {
          if: { properties: { resolution: { const: '4K' } } },
          then: { properties: { n: { maximum: 4 } } },
        },
      ],
    },
  },
  {
    id: 'flux-1.1-pro',
    name: 'FLUX 1.1 Pro',
    kind: 'image',
    capabilities: ['t2i'],
    schemaVersion: 1,
    'x-task': { mode: 'sync', timeoutMs: 120_000 },
    paramsSchema: {
      type: 'object',
      properties: {
        aspect_ratio: {
          type: 'string',
          enum: ['1:1', '16:9', '9:16', '4:3', '3:4'],
          default: '1:1',
          'x-ui': {
            control: 'chips',
            label: 'ui.media.param-aspect-ratio',
            order: 1,
            surface: ['studio', 'chat'],
          },
        },
        prompt_upsampling: {
          type: 'boolean',
          default: false,
          'x-ui': { control: 'switch', label: 'ui.media.param-prompt-upsampling', order: 2 },
        },
        safety_tolerance: {
          type: 'integer',
          minimum: 1,
          maximum: 6,
          default: 2,
          'x-ui': {
            control: 'slider',
            label: 'ui.media.param-safety-tolerance',
            order: 10,
            advanced: true,
          },
        },
        seed: {
          type: 'integer',
          minimum: 0,
          maximum: 2147483647,
          'x-ui': { control: 'text', label: 'ui.media.param-seed', order: 11, advanced: true },
        },
      },
    },
  },
];

export function getImageSpec(id: string): MediaModelSpec | undefined {
  return IMAGE_MODEL_SPECS.find((s) => s.id === id);
}
