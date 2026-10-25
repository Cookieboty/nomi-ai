/**
 * 模型规格（docs/design/cli-plugin-architecture.md §6.9.3）：能力是数据，不是名字猜测。
 * 按「族默认 → 内置目录 → 供应商覆盖 → 运行时学到的 → 用户设置」合并成 EffectiveModel，后者覆盖前者。
 */
import type { Wire } from '../ir';

export type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ReasoningControl = 'effort' | 'budget' | 'adaptive' | 'level' | 'toggle' | 'none';

/** 工具 schema 清理器（§6.9.6） */
export type SchemaVariant = 'full' | 'gemini' | 'openai-strict' | 'kimi' | 'deepseek';

export interface ModelReasoning {
  /** 这个模型怎么表达思考强度 */
  control: ReasoningControl;
  /** 支持的档位（发送前贴合，fitLevel） */
  efforts?: Effort[];
  budget?: { min?: number; max?: number };
  canDisable?: boolean;
  /** 历史推理要不要回传（§6.9.6） */
  passback?: 'required' | 'optional' | 'never';
  /** 回传用的字段名（reasoning_content / reasoning / reasoning_details） */
  passbackField?: string;
  /** toggle 型模型在 Chat 上的开关写法 */
  toggleStyle?: 'thinking-type' | 'enable-thinking';
}

/** 模型规格的数据部分（每一级都只写自己知道的字段） */
export interface ModelSpecData {
  family?: string;
  /**
   * context：总窗口；input：最大输入（有的厂商为输出预留一部分，input < context）；maxOutput：输出上限；
   * standard：标准窗口（超过它按长上下文加价，编程助手默认按它压缩，可按模型开启长上下文）
   */
  limits?: { context?: number; input?: number; standard?: number; maxOutput?: number };
  /** 模型的原生协议与理由（§6.9.4 排序规则 1） */
  wires?: { prefer: Wire[]; reason?: string };
  input?: { images?: boolean; pdf?: boolean };
  tools?: { calling?: boolean; parallel?: boolean; freeform?: boolean; schema?: SchemaVariant };
  reasoning?: ModelReasoning;
  /** false = 不接受（推理模型） */
  sampling?: { temperature?: boolean; topP?: boolean };
  params?: {
    maxTokensField?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';
    requireMaxTokens?: boolean;
  };
}

/** 族默认：只有这一级允许按名字 glob 匹配（只作回退） */
export interface ModelFamily extends ModelSpecData {
  family: string;
  /** 去掉供应商前缀后的模型 id glob（'gpt-5*'、'claude-opus-4-*'） */
  match: string[];
}

/** 合并后的模型规格；sources 记每个字段来自哪一级（诊断用） */
export interface EffectiveModel extends ModelSpecData {
  id: string;
  /** 用户明确设置过的字段（与学到的结论冲突时只提示，不覆盖） */
  userSet: string[];
  /** 参与合并的来源（按优先级从低到高） */
  sources: Array<'family' | 'catalog' | 'provider' | 'learned' | 'user'>;
  /** 严格模式：不支持的参数报错而不是丢弃（§6.9.6） */
  strict: boolean;
  /** 合并时用的目录版本 */
  catalogVersion: string;
}
