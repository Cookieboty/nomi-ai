/**
 * 看板娘（只内置 Nomi 一个角色）与看板娘窗口相关的共享类型。
 */

/** Per-character TTS binding (local/remote TTS voice preference). */
export interface ModelVoiceConfig {
  /** speechSynthesis.voiceURI or empty for auto soft pick (system fallback) */
  voiceURI?: string;
  /**
   * Name substring hint for system voices, and/or Fish built-in referenceId
   * (e.g. `nomi` → fish reference_id `nomi`).
   */
  voiceHint?: string;
  /** Explicit Fish built-in reference preset id when different from voiceHint */
  fishReferenceId?: string;
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

export interface MascotWindowApi {
  /** process.platform（Linux 用窗口形状实现点击穿透） */
  platform: string;
  /** Linux：可交互区域（窗口像素）；空数组 = 整个窗口 */
  setShape(rects: ShapeRect[]): void;
  setHit(hit: boolean): void;
  /** 角色包围盒（窗口像素）；vw / vh = 测量时的视口尺寸，主进程据此丢弃缩放前的旧测量 */
  setGeometry(box: {
    left: number;
    right: number;
    top: number;
    bottom: number;
    vw?: number;
    vh?: number;
  }): void;
  /** 屏幕坐标（screenX/Y）；省略时主进程读取系统光标 */
  dragStart(screenX?: number, screenY?: number): void;
  dragMove(screenX: number, screenY: number): void;
  dragEnd(): void;
  setConfig(cfg: Partial<MascotInteractionConfig>): void;
  wanderNow(): void;
  scaleGet(): Promise<MascotScaleState>;
  scaleSet(scale: number): Promise<MascotScaleState>;
  scaleStep(dir: 1 | -1): Promise<MascotScaleState>;
  /** Ctrl/⌘+滚轮：累计的 deltaY（向上滚 = 放大） */
  scaleWheel(deltaY: number, deltaMode?: number): Promise<MascotScaleState>;
  scaleReset(): Promise<MascotScaleState>;
  onScale(cb: (s: MascotScaleState) => void): () => void;
  snapshot(): Promise<{
    body: { x: number; y: number; vx: number; vy: number; mode: string };
    ignoring: boolean;
    shapeRects: number;
    clickThroughMode: 'ignore' | 'shape';
    box: { left: number; right: number; top: number; bottom: number } | null;
    cfg: MascotInteractionConfig;
  }>;
  onCursor(cb: (p: MascotCursorEvent) => void): () => void;
  onBody(cb: (p: MascotBodyEvent) => void): () => void;
  onPhysicsEvent(cb: (p: MascotPhysicsEvent) => void): () => void;
}

/** 桌面能力确认请求（主进程 PermissionBroker → 看板娘窗口） */
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

export interface DesktopApi {
  onConfirmRequest(cb: (req: DesktopConfirmRequest) => void): () => void;
  onConfirmCancel(cb: (id: string) => void): () => void;
  onBubble(cb: (p: DesktopBubble) => void): () => void;
  answer(id: string, allow: boolean, remember: boolean): void;
  dropFile(file: File): boolean;
  onReminder(cb: (p: DesktopReminderEvent) => void): () => void;
  takeMissedReminders(): Promise<DesktopReminderEvent[]>;
  reminderAction(id: string, action: 'dismiss' | 'snooze', minutes?: number): void;
}

export interface DesktopReminderEvent {
  id: string;
  text: string;
  dueAt: number;
  missed?: boolean;
}
