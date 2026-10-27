/**
 * 媒体生成（P0 只做图片）的模型 schema 契约：参数 schema 属于「模型」，同一模型可由多家供应商提供。
 *
 * paramsSchema 是 JSON Schema 的受限子集：
 * - properties：每个字段必须带 `x-ui`（控件 / 标签 / 顺序 / 出现在哪些界面）；
 * - allOf：只允许 `{ if: { properties: { k: { const } } }, then: { properties?, 'x-hidden'? } }`，
 *   if 内多个守卫为合取，then 只能收紧 enum / minimum / maximum 或隐藏字段；不支持 else / 嵌套。
 *
 * 纯类型，主进程与渲染层共用（不依赖 Node / DOM）。
 */

export type MediaKind = 'image' | 'video';
export type MediaCapability = 't2i' | 'i2i' | 'edit' | 't2v' | 'i2v' | 'flf2v';
export type ParamValue = string | number | boolean;
export type MediaParams = Record<string, ParamValue | undefined>;

export type UiControl = 'chips' | 'select' | 'slider' | 'stepper' | 'switch' | 'text';
/** 字段出现在哪些界面：studio = 图片工作台，chat = 对话（也决定 generate_image 工具参数） */
export type UiSurface = 'studio' | 'chat';

export interface ParamUi {
  control: UiControl;
  /** 稳定 i18n key（渲染层 t() 翻译） */
  label: string;
  order: number;
  advanced?: boolean;
  surface?: UiSurface[];
  step?: number;
  optionLabels?: Record<string, string>;
  /** 工作台控件形态：segmented = 整数取值渲染成分段按钮（不写则按取值范围自动判断） */
  widget?: 'segmented';
  /** 仅限制 UI 可选上限（API 上限仍以 maximum 为准），配合 widget: 'segmented' 使用 */
  uiMax?: number;
}

export interface ParamSchema {
  type: 'string' | 'integer' | 'number' | 'boolean';
  enum?: ParamValue[];
  minimum?: number;
  maximum?: number;
  default?: ParamValue;
  'x-ui': ParamUi;
}

export interface ConditionalRule {
  if: { properties: Record<string, { const: ParamValue }> };
  then: {
    properties?: Record<string, Pick<ParamSchema, 'enum' | 'minimum' | 'maximum'>>;
    'x-hidden'?: string[];
  };
}

export interface ParamsSchema {
  type: 'object';
  properties: Record<string, ParamSchema>;
  allOf?: ConditionalRule[];
}

export interface MediaInputSpec {
  image?: { max: number; roles: string[]; label: string };
}

export interface MediaTaskSpec {
  /** P0 图片全部 sync；任务层按异步设计（async-poll 留给视频） */
  mode: 'sync' | 'async-poll';
  pollMs?: number;
  timeoutMs?: number;
}

export interface MediaModelSpec {
  id: string;
  name: string;
  kind: MediaKind;
  capabilities: MediaCapability[];
  paramsSchema: ParamsSchema;
  'x-media'?: MediaInputSpec;
  'x-task': MediaTaskSpec;
  /** 本模型 schema 的版本；字段语义变化时 +1，旧参数经 migrateParams 迁移 */
  schemaVersion: number;
}

/** 协议 preset：主进程据此组装请求（Key 不进渲染层） */
export type MediaProtocol =
  'openai-images' | 'gemini' | 'ark-image' | 'openrouter-chat-image' | 'fal';

/** 供应商 × 模型绑定：先选模型，再选能提供它的供应商 */
export interface ProviderBinding {
  providerRef: string;
  modelId: string;
  enabled: boolean;
  presetKey: MediaProtocol;
  upstreamModelName: string;
}

export interface MediaModelChoice {
  modelId: string;
  providerRef: string;
}

export type AssetSource =
  'chat_generated' | 'chat_upload' | 'chat_reply' | 'studio' | 'manual_add' | 'agent';

export const ASSET_SOURCES: readonly AssetSource[] = [
  'chat_generated',
  'chat_upload',
  'chat_reply',
  'studio',
  'manual_add',
  'agent',
];

export interface MediaPrefs {
  /** 对话默认生图模型；null = 未配置（对话里显示引导卡，不调用任何模型） */
  chatDefaultImage: MediaModelChoice | null;
  /** 图片工作台上次的选择 */
  studioLast: (MediaModelChoice & { params?: MediaParams }) | null;
  /** 生成的图片自动入库（默认开） */
  autoAddGenerated: boolean;
  /** 上传 / 附带的图片自动入库（默认关，隐私） */
  autoAddUploads: boolean;
  /** 我的默认参数（按模型） */
  userDefaults: Record<string, MediaParams>;
}

export const DEFAULT_MEDIA_PREFS: MediaPrefs = {
  chatDefaultImage: null,
  studioLast: null,
  autoAddGenerated: true,
  autoAddUploads: false,
  userDefaults: {},
};
