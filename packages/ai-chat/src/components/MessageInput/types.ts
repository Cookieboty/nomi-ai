/** 发文框的属性（从 index.tsx 拆出，控制单文件行数） */
import type { createComposerDraftStore } from '../../services/composerDrafts';
import type { ImageAttachment } from '../../services/screenClient';
import type { SlashBridge } from '../../slash/types';
import type { ConvMessage } from '../../types/conversation';
import type { PendingMode } from '../../utils/pendingSends';
import type { SettingsSection } from '../SettingsView/sections';

export interface MessageInputProps {
  /** CLI 标签可附带图片；第二参仅在有附图时传入 */
  onSend?: (message: string, images?: ImageAttachment[]) => void;
  /** 独立于 Nomi 对话的忙碌状态（CLI 标签）；设置后不再看 Nomi 的 isLoading / 模型 */
  busyOverride?: boolean;
  /**
   * CLI 标签的发图能力。不传 = Nomi 路径（走 vision）。
   * `none`：可预览附件但发送时明确提示，不静默丢图。
   */
  imageCapability?: 'full' | 'none';
  /** 不能附图的原因（模型不支持看图 / dsh 没有图片输入） */
  imageUnsupportedReason?: string;
  /** 设置 busyOverride（CLI 标签）时始终使用这里的提示，不显示 Nomi 的模型提示 */
  placeholder?: string;
  /**
   * 运行中也能继续输入（见 utils/pendingSends）：Enter 插入这一轮（mode steer），Ctrl/⌘+Enter 排队到
   * 这一轮结束（mode queue），都先进输入框上方的待发列表；Esc 在待发列表非空时停止这一轮、合成一条马上发出。
   * 输入为空时发送键变成「停止」。不传则保持原行为（运行中禁用输入）。
   */
  queue?: {
    onQueue: (text: string, opts?: { kb?: boolean; mode?: PendingMode }) => void;
    onStop?: () => void;
    /** 待发列表里有几条（Esc 据此决定要不要停下来马上发） */
    pending?: number;
    onFlush?: () => void;
  };
  disabled?: boolean;
  onProvidersClick?: () => void;
  onDesktopClick?: () => void;
  /** 打开「知识 · 记忆 · 日程」快速视图 */
  onHubClick?: () => void;
  onExtClick?: () => void;
  onLocalClick?: () => void;
  /** 打开统一设置页的某个分区 */
  onSettingsClick?: (section?: SettingsSection, endpoint?: string) => void;
  /** 斜杠命令桥：传入后输入 / 弹出统一命令面板并接管执行；不传则只有输入框自带的界面命令 */
  slash?: SlashBridge;
  /** 打开「插件 / 命令」只读面板 */
  onPluginsClick?: () => void;
  /** 发送钮旁上下文占用环的数据源 */
  contextMessages?: readonly ConvMessage[];
  contextModel?: string | null;
  /** 外部（如右栏「让助手提交」）请求填入的文字：接在已有草稿后面并聚焦，不自动发送 */
  fill?: { text: string; nonce: number } | null;
  /** 会话工作区 cwd（files rail）；有值时输入 @ 可路径补全 */
  cwd?: string | null;
  /** App 持有的会话草稿 Map；与 draftKey 一起传入时按会话隔离输入 */
  draftStore?: ReturnType<typeof createComposerDraftStore>;
  /** 当前激活草稿桶；勿用 React key 整棵重挂本组件 */
  draftKey?: string;
}
