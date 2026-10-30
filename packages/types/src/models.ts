/**
 * 看板娘（只内置 Nomi 一个角色）与看板娘窗口相关的共享类型。
 */

/** Per-character TTS binding (local/remote TTS voice preference). */
export interface ModelVoiceConfig {
  /** speechSynthesis.voiceURI or empty for auto soft pick (system fallback) */
  voiceURI?: string;
  /** Voice name hint for a realtime engine (e.g. `nomi`) */
  voiceHint?: string;
  /** Speech rate 0.5..1.5 (system fallback) */
  rate?: number;
  /** Pitch 0..2 (system fallback) */
  pitch?: number;
}

/** 用户可调的模型呈现配置（导入模型 / 任意模型的本地覆盖），可导出为 JSON。 */
export interface ModelConfig {
  /** 显示名（覆盖 meta 里的名字） */
  name?: string;
  /** 缩放，0.1 ~ 5 */
  scale?: number;
  /** 位置偏移（米），各分量 -5 ~ 5 */
  offset?: [number, number, number];
  /** 镜头取景 */
  camera?: { height?: number; distance?: number; fov?: number };
  /** 通用表情名 → 模型表情名（如 happy → Joy） */
  expressionMap?: Record<string, string>;
  /** 允许的身体动作；缺省 = 全部 */
  motions?: string[];
  /** Soft TTS voice for this character (defaults in model-list; user override persists here / local) */
  voice?: ModelVoiceConfig;
}

/** VRM meta 摘要（用于用户导入模型的许可提示） */
/** 经审核的非 OSI 许可（允许商用 + 再分发）的条款与条件 */
export interface LicenseTermsView {
  name: string;
  url: string;
  conditions: {
    commercialUse: boolean;
    redistribution: boolean;
    modification?: boolean;
    credit?: boolean;
    prohibited?: string[];
  };
}

/** 看板娘窗口互动（主进程 MascotWindowController ⇄ 渲染进程） */
export interface MascotInteractionConfig {
  clickThrough: boolean;
  gravity: boolean;
  wander: boolean;
  reactions: boolean;
  globalLook: boolean;
  /** 在气泡里显示 AI 回复摘要（渲染进程本地设置） */
  bubbleReplies: boolean;
}

export interface MascotCursorEvent {
  /** 相对窗口左上角的像素坐标（可能在窗口外） */
  x: number;
  y: number;
  inside: boolean;
}

export interface MascotBodyEvent {
  mode: 'idle' | 'held' | 'falling' | 'walking';
  vx: number;
  vy: number;
  ax: number;
  ay: number;
  dir: number;
}

export type MascotPhysicsEvent =
  | { type: 'grab' }
  | { type: 'release'; vx: number; vy: number }
  | { type: 'land'; speed: number }
  | { type: 'bounce'; speed: number }
  | { type: 'wall'; side: 'left' | 'right'; speed: number }
  | { type: 'arrive' };

export interface ShapeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 看板娘大小（主进程按屏幕可用区域夹紧，窗口随之调整，脚底中心不动） */
export interface MascotScaleState {
  scale: number;
  min: number;
  max: number;
  hardMax: number;
  default: number;
  step: number;
  window: { width: number; height: number };
}

/** 桌面能力确认请求（主进程 PermissionBroker → 对话窗口或看板娘窗口） */
export interface DesktopConfirmRequest {
  id: string;
  tool: string;
  danger: 'read' | 'write' | 'destructive';
  summary: string;
  argsJson: string;
  preview?: string;
  /** 必须在详情对话框中确认 */
  dialog: boolean;
  rememberable: boolean;
  reason: string;
  expiresAt: number;
  /** scope：请用户授权文件夹（对话窗口里的卡片）；scopePath 为模型建议的文件夹 */
  kind?: 'scope';
  scopePath?: string;
  scopeMode?: 'read' | 'read-write';
}

/**
 * 主进程推给看板娘的气泡。voice 决定要不要出声（默认 full = 朗读气泡文字）：
 * - full：朗读整段气泡文字
 * - cue：只播放事件提示音，不朗读气泡文字
 * - none：只显示气泡，不出声也不放音效
 * kind 明确事件类型（不再从文案推断）：digest = 定时汇总，done / fail = 任务结束。
 */
export interface DesktopBubble {
  text: string;
  voice?: 'full' | 'cue' | 'none';
  kind?: 'digest' | 'done' | 'fail';
}

export interface DesktopReminderEvent {
  id: string;
  text: string;
  dueAt: number;
  missed?: boolean;
}

/**
 * 思考深度档位（各 CLI 取值的并集，顺序即由浅到深）。主进程与对话窗口共用的唯一定义。
 * 只用于识别 / 排序 CLI 返回的值；某个模型实际支持哪些档位以 CLI 返回为准。
 *
 * Responses API `reasoning.effort` 含 none|minimal|low|medium|high|xhigh|max（无 ultra）。
 * Codex 协议/CLI/Desktop 另有 client 档 `ultra`：用户侧选 ultra；推理请求边界把 ultra→max，
 * 并开启 proactive multi-agent（Ultra ≠ Max：Max=单任务更深；Ultra=子 agent 并行）。
 * 因此保留 max 与 ultra 为两个独立档位；normalizeEfforts 不得丢弃 CLI 返回的 ultra。
 * 传给 Codex CLI 时原样传 model_reasoning_effort="ultra"（由 Codex 自己转 max）。
 */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
