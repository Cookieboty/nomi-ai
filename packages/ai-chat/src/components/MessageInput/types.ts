/** 发文框的属性（从 index.tsx 拆出，控制单文件行数） */
import type React from 'react';

import type { createComposerDraftStore } from '../../services/composerDrafts';
import type { HarnessTabMeta } from '../../services/harnessClient';
import type { ImageAttachment } from '../../services/screenClient';
import type { SlashBridge } from '../../slash/types';
import type { ConvMessage } from '../../types/conversation';
import type { PendingMode } from '../../utils/pendingSends';
import type { SettingsSectionInput } from '../SettingsView/sections';

export interface MessageInputProps {
  /** 发送前守卫（返回 false 时中止发送并保留草稿；不拦截斜杠命令） */
  onBeforeSend?: () => boolean;
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
    onQueue: (
      text: string,
      opts?: { kb?: boolean; mode?: PendingMode; images?: ImageAttachment[]; imageOnly?: boolean },
    ) => void;
    onStop?: () => void;
    /** 待发列表里有几条（Esc 据此决定要不要停下来马上发） */
    pending?: number;
    onFlush?: () => void;
  };
  disabled?: boolean;
  /** Preview composer: one-line pill geometry, preserving the same mounted draft/queue. */
  compact?: boolean;
  /** Integrated preview window: shared composer with no nested card or focus ring. */
  floating?: boolean;
  onProvidersClick?: () => void;
  onDesktopClick?: () => void;
  /** 打开「知识 · 记忆 · 日程」快速视图 */
  onHubClick?: () => void;
  onExtClick?: () => void;
  onLocalClick?: () => void;
  /** 打开统一设置页的某个分区 */
  onSettingsClick?: (section?: SettingsSectionInput, endpoint?: string) => void;
  /** 斜杠命令桥：传入后输入 / 弹出统一命令面板并接管执行；不传则只有输入框自带的界面命令 */
  slash?: SlashBridge;
  /** 打开「插件 / 命令」只读面板 */
  onPluginsClick?: () => void;
  /** 发送钮旁上下文占用环的数据源 */
  contextMessages?: readonly ConvMessage[];
  contextModel?: string | null;
  /** 外部（如右栏「让助手提交」）请求填入的文字与附图：接在已有草稿后面并聚焦，不自动发送 */
  fill?: { text: string; images?: ImageAttachment[]; nonce: number } | null;
  /** 会话工作区 cwd（files rail）；有值时输入 @ 可路径补全 */
  cwd?: string | null;
  /** All project folders for path completion. */
  roots?: readonly string[] | null;
  /** Nomi 对话：「+」菜单里有「交给 agent」（CLI 标签没有） */
  delegate?: boolean;
  /** App 持有的会话草稿 Map；与 draftKey 一起传入时按会话隔离输入 */
  draftStore?: ReturnType<typeof createComposerDraftStore>;
  /** 当前激活草稿桶；勿用 React key 整棵重挂本组件 */
  draftKey?: string;
  /**
   * 模型 / 权限绑到这个标签，而不是当前标签。
   * 侧栏里的委派会话和主列同时开着时用它。
   */
  endpointTab?: HarnessTabMeta | null;
  /**
   * 侧边聊天：用这个代替「模型 · 思考深度」按钮（绑在那个侧边聊天上），不显示权限模式。
   * 不传 = 按 endpointTab / 当前标签显示。
   */
  modelControl?: React.ReactNode;
  /** 接收工作区文件路径拖放的容器区域（如整个 chat-column 或侧栏聊天面板） */
  dropZoneRef?: React.RefObject<HTMLElement | null>;
  /** 铺满模式下经标签拖放触发主对话插入路径的自定义事件名 */
  dropEvent?: string;
}
