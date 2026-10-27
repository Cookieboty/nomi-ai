import { createLogger, t as tr, Icon, useLocale } from '@nomi-ai/ui';
import { BookOpen, Blocks, X, ArrowUp, ListPlus, Plus, Square } from 'lucide-react';
import React, {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  useRef,
  type KeyboardEvent,
} from 'react';

import {
  selectError,
  selectIsLoading,
  selectStreaming,
  useAiChatActions,
  useAiChatSelector,
} from '../../contexts/aiChatStore';
import { useNextDelegate } from '../../hooks/useNextDelegate';
import { delegateClient, setNextDelegate, type DelegateCli } from '../../services/delegateClient';
import { extClient } from '../../services/extClient';
import {
  MAX_FILE_ATTACHMENTS,
  fileAttachmentFrom,
  joinFileAttachments,
  type FileAttachment,
} from '../../services/fileAttachments';
import { kbClient } from '../../services/kbClient';
import { memClient } from '../../services/memClient';
import { nomiModelLabel, nomiModelMeta } from '../../services/nomiModel';
import { schedClient } from '../../services/schedClient';
import {
  MAX_ATTACHMENTS,
  attachmentFromFile,
  likelyVision,
  fromRaw,
  screenClient,
  type RawAttachment,
  type ImageAttachment,
} from '../../services/screenClient';
import {
  formatCombo,
  getBindings,
  matchShortcut,
  useShortcutBindings,
} from '../../services/shortcuts';
import { agentArgQuery, filterAgents, type AgentOption } from '../../slash/agentComplete';
import { argPhase, paletteQuery } from '../../slash/parse';
import { buildRegistry, findCommand, flattenGroups, searchCommands } from '../../slash/registry';
import type { SlashBridge, SlashCommand } from '../../slash/types';
import type { ConvMessage } from '../../types/conversation';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { CYCLE_PERMISSION_EVENT, type CyclePermissionDetail } from '../../utils/permissionModes';
import { AppIcon, FEATURE_ICONS } from '../AppIcons';
import { EndpointControls, PermissionTip } from '../EndpointControls';
import { ErrorHint } from '../ErrorHint';
import { FileChip } from '../FileAttachment';
import { ComposerChangesPill } from '../SessionWorkspace/ComposerChangesPill';
import { ContextUsageBar } from '../SessionWorkspace/ContextUsageBar';
import type { SettingsSection } from '../SettingsView/sections';
import { AgentPalette, SlashPalette } from '../SlashPalette';
import { VoiceButtons, VoiceSettingsModal, VoiceStatusRow, useChatVoice } from '../VoiceInput';

import { ImageLightbox } from './ImageLightbox';
import styles from './index.module.css';

const log = createLogger('message-input');

/** 发文框默认更高；超过 COMPOSER_MAX 后框内滚动。 */
export const COMPOSER_MIN_HEIGHT_PX = 72;
export const COMPOSER_MAX_HEIGHT_PX = 240;

interface MessageInputProps {
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
   * 运行中也能继续输入：Enter 把消息排进队列（当前轮结束后自动发送）；输入为空时发送键变成「停止」。
   * 不传则保持原行为（运行中禁用输入）。
   */
  queue?: { onQueue: (text: string, opts?: { kb?: boolean }) => void; onStop?: () => void };
  disabled?: boolean;
  onProvidersClick?: () => void;
  onDesktopClick?: () => void;
  /** 打开「知识 · 记忆 · 日程」快速视图 */
  onHubClick?: () => void;
  onScreenClick?: () => void;
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
}

const MessageInputImpl: React.FC<MessageInputProps> = ({
  onSend,
  busyOverride,
  imageCapability,
  imageUnsupportedReason,
  placeholder = tr('ui.knowledge-local.type-a-message'),
  queue,
  disabled = false,
  onProvidersClick,
  onDesktopClick,
  onHubClick,
  onScreenClick,
  onExtClick,
  onLocalClick,
  onSettingsClick,
  slash,
  onPluginsClick,
  contextMessages,
  contextModel,
  fill,
}) => {
  // 语言切换时重渲染：memo 挡住了根组件的更新，这里自己订阅（#140）
  useLocale();
  const bindings = useShortcutBindings();
  const [message, setMessage] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [slashIdx, setSlashIdx] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const [isComposing, setIsComposing] = useState(false);
  const [agentIdx, setAgentIdx] = useState(0);
  /** 按 Esc 关掉助手列表时的输入；输入一变就重新出现 */
  const [agentClosed, setAgentClosed] = useState<string | null>(null);
  /** `/agent ` 补全用的已安装编程助手（委派设置里的检测结果）；null = 还没读到 */
  const [agentInstalled, setAgentInstalled] = useState<DelegateCli[] | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 列向 flex 里 flex:1 的基准高度是 0，行内 height 不生效，所以这里按内容写回，并封顶。
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.maxHeight = `${COMPOSER_MAX_HEIGHT_PX}px`;
    el.style.height = '0px';
    const next = Math.min(
      Math.max(el.scrollHeight, COMPOSER_MIN_HEIGHT_PX),
      COMPOSER_MAX_HEIGHT_PX,
    );
    el.style.height = `${next}px`;
  }, [message]);
  // 挂载时已有的请求视为处理过（切标签重挂载不再重复填入）
  const seenFill = useRef(fill?.nonce);
  const fillNonce = fill?.nonce;
  useEffect(() => {
    if (!fill || fill.nonce === seenFill.current) return;
    seenFill.current = fill.nonce;
    setMessage((cur) => (cur.trim() ? `${cur.replace(/\s+$/, '')}\n\n${fill.text}` : fill.text));
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      el.scrollTop = el.scrollHeight;
    });
  }, [fillNonce]); // eslint-disable-line react-hooks/exhaustive-deps -- 只按 nonce 触发
  // slices only: streamed frames (message content) do not rerender the composer
  const { dispatch, actions, store: chatStore } = useAiChatActions();
  const isLoading = useAiChatSelector(selectIsLoading);
  const streaming = useAiChatSelector(selectStreaming);
  const chatError = useAiChatSelector(selectError);
  // 知识库问答模式（Ctrl/Cmd+Shift+K 切换），记住上次的选择
  // `/cli 名字`：下一个需求交给哪个编程助手（输入栏上的 chip，点 × 取消）
  const nextDelegate = useNextDelegate();
  const [kbMode, setKbMode] = useState(() => {
    try {
      return localStorage.getItem('cd.chat.kbMode') === '1';
    } catch {
      return false;
    }
  });
  const kbAvailable = kbClient.available();
  const toggleKb = useCallback(() => {
    setKbMode((v) => {
      try {
        localStorage.setItem('cd.chat.kbMode', v ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !v;
    });
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);
  useEffect(() => {
    if (!kbAvailable) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (matchShortcut(e, getBindings().kbAsk)) {
        e.preventDefault();
        toggleKb();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [kbAvailable, toggleKb]);

  // ───── 图片附件：粘贴 / 拖入 / 截图提问 ─────
  const [images, setImages] = useState<ImageAttachment[]>([]);
  /** 点缩略图放大查看的那张 */
  const [viewing, setViewing] = useState<ImageAttachment | null>(null);
  const closeViewer = useCallback(() => setViewing(null), []);
  const [imgErr, setImgErr] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [snipping, setSnipping] = useState(false);
  const screenOk = screenClient.available();
  const addImages = useCallback((list: ImageAttachment[]) => {
    setImgErr('');
    setImages((cur) => {
      const next = [...cur, ...list];
      if (next.length > MAX_ATTACHMENTS)
        setImgErr(tr('ui.knowledge-local.up-to-images', MAX_ATTACHMENTS));
      return next.slice(0, MAX_ATTACHMENTS);
    });
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);
  const addFiles = useCallback(
    async (files: File[]) => {
      const imgs = files.filter((f) => f.type.startsWith('image/'));
      if (!imgs.length) return false;
      const out: ImageAttachment[] = [];
      for (const f of imgs) {
        try {
          out.push(await attachmentFromFile(f));
        } catch (e) {
          setImgErr((e as Error).message);
        }
      }
      if (out.length) addImages(out);
      return true;
    },
    [addImages],
  );
  // 非图片文件：小文本文件连内容发，其余只发路径（services/fileAttachments.ts）
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const addOtherFiles = useCallback(async (list: File[]) => {
    const out: FileAttachment[] = [];
    for (const f of list) {
      const a = await fileAttachmentFrom(f);
      if (a) out.push(a);
      else setImgErr(tr('ui.knowledge-local.can-t-read-file', f.name));
    }
    if (!out.length) return;
    setFiles((cur) => {
      const next = [...cur, ...out];
      if (next.length > MAX_FILE_ATTACHMENTS)
        setImgErr(tr('ui.knowledge-local.up-to-files', MAX_FILE_ATTACHMENTS));
      return next.slice(0, MAX_FILE_ATTACHMENTS);
    });
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);
  /** 拖入 / 粘贴的文件：图片作图片附件，其余作文件附件；有文件返回 true */
  const takeFiles = useCallback(
    (list: File[]) => {
      if (!list.length) return false;
      const imgs = list.filter((f) => f.type.startsWith('image/'));
      const others = list.filter((f) => !f.type.startsWith('image/'));
      if (imgs.length) void addFiles(imgs);
      if (others.length) void addOtherFiles(others);
      return true;
    },
    [addFiles, addOtherFiles],
  );
  // 整个对话窗口都能拖入文件（不只输入框），拖动时高亮输入框
  const takeFilesRef = useRef(takeFiles);
  useLayoutEffect(() => {
    takeFilesRef.current = takeFiles;
  }, [takeFiles]);
  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      setDragOver(true);
    };
    const onLeave = (e: DragEvent) => {
      // relatedTarget 为空 = 拖出了窗口
      if (!e.relatedTarget) setDragOver(false);
    };
    const onDrop = (e: DragEvent) => {
      setDragOver(false);
      if (!hasFiles(e)) return;
      e.preventDefault();
      takeFilesRef.current(Array.from(e.dataTransfer?.files ?? []));
    };
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);
  const snip = useCallback(async () => {
    if (!screenOk || snipping) return;
    setSnipping(true);
    setImgErr('');
    try {
      const a = await screenClient.snip();
      if (a) {
        addImages([a]);
        if (!textareaRef.current?.value)
          setMessage(tr('ui.knowledge-local.what-s-in-this-screenshot'));
      }
    } catch (e) {
      setImgErr((e as Error).message);
    } finally {
      setSnipping(false);
    }
  }, [screenOk, snipping, addImages]);
  // 全局快捷键截图后，主进程把附件推过来
  useEffect(
    () =>
      screenClient.onAttachment((a) => {
        addImages([a]);
        setMessage((m) => m || tr('ui.knowledge-local.what-s-in-this-screenshot'));
      }),
    [addImages],
  );
  // 本地中心（剪贴板历史）发来的图片 / 文字
  useEffect(() => {
    const onImg = (e: Event) =>
      void fromRaw((e as CustomEvent<RawAttachment>).detail).then((a) => a && addImages([a]));
    const onText = (e: Event) => {
      const t = String((e as CustomEvent<string>).detail ?? '');
      setMessage((m) => (m ? `${m}\n${t}` : t));
      requestAnimationFrame(() => textareaRef.current?.focus());
    };
    window.addEventListener('cd:attach-image', onImg);
    window.addEventListener('cd:insert-text', onText);
    return () => {
      window.removeEventListener('cd:attach-image', onImg);
      window.removeEventListener('cd:insert-text', onText);
    };
  }, [addImages]);
  useEffect(() => {
    if (!screenOk) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (matchShortcut(e, getBindings().snip)) {
        e.preventDefault();
        void snip();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [screenOk, snip]);
  const chatModel = nomiModelLabel() ?? '';
  // 模型元数据写明了视觉能力就以它为准，否则按名字猜
  const visionKnown = nomiModelMeta()?.vision;
  // 编程助手标签由调用方给出发图能力（当前 CLI 模型），不能拿 Nomi 自己的模型去判断
  const visionWarn =
    images.length > 0 &&
    (imageCapability !== undefined
      ? imageCapability === 'none'
      : !(visionKnown ?? likelyVision(chatModel)));

  const handleSend = async () => {
    let trimmedMessage =
      message.trim() ||
      (images.length
        ? tr('ui.knowledge-local.please-take-a-look-at-this-image')
        : files.length
          ? tr('ui.knowledge-local.please-take-a-look-at-these-files')
          : '');
    if (!trimmedMessage) return;
    // 斜杠命令：原生命令 / 未知命令 / 自定义命令都在这里被接管；`//x` 转义成普通文字 `/x`
    if (slash && !images.length && !files.length && trimmedMessage.startsWith('/')) {
      const scopeAtStart = slash.scope?.();
      const r = await slash.run(trimmedMessage, getRegistry());
      if (r.handled) {
        // 命令是异步的：完成时用户若已切到别的会话，输入框里是那边的草稿，不能清掉
        if (scopeAtStart === undefined || slash.scope?.() === scopeAtStart) setMessage('');
        return;
      }
      if (r.text !== undefined) trimmedMessage = r.text;
    }
    // 文件附件拼在正文末尾，随文字一起走（排队也带上）
    const sendFiles = files;
    const typed = trimmedMessage;
    trimmedMessage = joinFileAttachments(trimmedMessage, sendFiles);
    if (busy) {
      // 运行中：文字消息进队列（带图片的消息不排队，等当前轮结束再发）
      if (queue && !images.length) {
        // 入队时冻结知识库模式：排队期间切换开关不改变这条消息的去向
        if (kbMode && kbAvailable) queue.onQueue(trimmedMessage, { kb: true });
        else queue.onQueue(trimmedMessage);
        setMessage('');
        setFiles([]);
      }
      return;
    }
    const sendImages = images;

    try {
      setMessage('');
      setImages([]);
      setFiles([]);
      setImgErr('');
      if (sendImages.length && imageCapability === 'none') {
        setImgErr(
          imageUnsupportedReason ??
            tr('ui.session-workspace.the-current-model-doesn-t-support-images-remove'),
        );
        setImages(sendImages);
        setFiles(sendFiles);
        setMessage(typed);
      } else if (sendImages.length && onSend && busyOverride !== undefined) {
        onSend(trimmedMessage, sendImages);
      } else if (sendImages.length) {
        await actions.sendStreamMessage(trimmedMessage, sendImages);
      } else if (onSend) {
        onSend(trimmedMessage);
      } else if (kbMode && kbAvailable) {
        await actions.askKnowledge(trimmedMessage);
      } else {
        // 默认使用流式消息
        await actions.sendStreamMessage(trimmedMessage);
      }
    } catch (error) {
      log.error('发送消息失败:', error);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 处理输入法组合状态
    if (isComposing || e.nativeEvent.isComposing) return;

    // `/agent ` 后选编程助手：↑↓ 选择，Enter / Tab 选用，Esc 关闭列表
    if (agentOpen) {
      const n = agentOptions.length;
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && n) {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        setAgentIdx((i) => (i + d + n) % n);
        return;
      }
      const o = agentOptions[Math.min(agentIdx, n - 1)];
      // 名字已经敲全（如 `/agent codex`）时 Enter 照常执行命令，不再拦下补全
      const typed = (agentQuery ?? '').toLowerCase();
      const exact = !!typed && agentOptions.some((x) => x.id === typed);
      if ((e.key === 'Enter' && !e.shiftKey && !exact) || (e.key === 'Tab' && !e.shiftKey)) {
        if (o?.installed) {
          e.preventDefault();
          pickAgent(o);
          return;
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setAgentClosed(message);
        return;
      }
    }

    // 斜杠命令：↑↓ 选择，Enter 执行（需要参数的先补全），Tab 补全，Esc 关闭
    if (slashOpen) {
      const n = slashFlat.length;
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && n) {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        setSlashIdx((i) => (i + d + n) % n);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const c = slashFlat[Math.min(slashIdx, n - 1)]?.command;
        if (c) pickCommand(c, e.key === 'Tab' ? 'complete' : 'run');
        // 没有匹配：交给发送流程，由它拦下并显示「未知命令」卡片（不会发给模型）
        else if (e.key === 'Enter') void handleSend();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMessage('');
        return;
      }
    }
    // Shift+Tab：切换编程助手的权限模式（同 Claude Code）；没有模式按钮时保持默认行为
    if (e.key === 'Tab' && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const detail: CyclePermissionDetail = { handled: false };
      window.dispatchEvent(new CustomEvent(CYCLE_PERMISSION_EVENT, { detail }));
      if (detail.handled) e.preventDefault();
      return;
    }
    // ↑ 在空输入框里找回上一条提问（同 Codex）
    if (e.key === 'ArrowUp' && !message) {
      const last = [...chatStore.get().messages].reverse().find((m) => m.role === 'user');
      if (last) {
        e.preventDefault();
        setMessage(last.content);
      }
      return;
    }

    // Ctrl/Cmd + Enter 发送消息
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSend();
      return;
    }

    // Enter 发送消息（Shift + Enter 换行）
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
      return;
    }
  };

  const handleCompositionStart = () => {
    setIsComposing(true);
  };

  const handleCompositionEnd = () => {
    setIsComposing(false);
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setMessage(e.target.value);
    setSlashIdx(0);
    setAgentIdx(0);
    // 刚敲下 `/`：重新读一次项目 / 用户命令目录（文件可能刚被改过）
    if (e.target.value === '/') slash?.refresh();
  };

  const busy = busyOverride ?? isLoading;
  const isDisabled =
    disabled ||
    (busyOverride !== undefined ? (queue ? false : busyOverride) : queue ? false : isLoading);

  // 停止：Nomi 流式生成中，或编程助手标签自带的停止；输入为空才显示（有字时发送键是「排队」）
  const stopFn =
    busyOverride === undefined ? (streaming ? actions.stopGeneration : undefined) : queue?.onStop;
  // 仅在运行中（busy）才可能出现停止键：排队模式下输入为空才停止（有字时发送键是「排队」）。
  // 旧写法缺 busy 前置条件，导致 CLI 标签空闲时也显示停止键（点击 tabs.cancel 空操作）。
  const canStop =
    !!stopFn && busy && (!queue || (!message.trim() && !images.length && !files.length));

  // 语音：自动发送（对话空闲时）或填入输入框
  const busyRef = useRef(false);
  useEffect(() => {
    busyRef.current = isDisabled || busy;
  }, [isDisabled, busy]);
  const onVoiceText = useCallback(
    (text: string, autoSend: boolean) => {
      if (autoSend && !busyRef.current) {
        void (onSend
          ? Promise.resolve(onSend(text))
          : kbMode && kbAvailable
            ? actions.askKnowledge(text)
            : actions.sendStreamMessage(text));
        return;
      }
      setMessage((m) => (m ? `${m} ${text}` : text));
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    [onSend, actions, kbMode, kbAvailable],
  );
  const cv = useChatVoice({ disabled, onText: onVoiceText });

  const openModels = () => onProvidersClick?.();
  type Cmd = {
    id: string;
    icon: React.ReactNode;
    label: string;
    hint?: string;
    testId: string;
    run: () => void;
    show: boolean;
    active?: boolean;
    /** 出现在 ＋ 菜单里（其余只走 / 命令、快捷键与顶栏/设置） */
    menu?: boolean;
  };
  // 命令项的 run 函数捕获了 textareaRef 等用于事件处理，react-hooks/refs 对此过度推断，豁免此处
  const allCommands: Cmd[] = [
    {
      id: 'kb',
      icon: <AppIcon icon={FEATURE_ICONS.kb} />,
      label: kbMode
        ? tr('ui.knowledge-local.knowledge-base-q-a-on')
        : tr('ui.knowledge-local.knowledge-base-q-a-off'),
      hint: formatCombo(bindings.kbAsk),
      testId: 'kb-mode-toggle',
      menu: true,
      run: toggleKb,
      show: kbAvailable,
      active: kbMode,
    },
    {
      id: 'snip',
      icon: <AppIcon icon={FEATURE_ICONS.snip} />,
      label: tr('ui.knowledge-local.ask-about-a-screenshot'),
      hint: formatCombo(bindings.snip),
      testId: 'snip-button',
      menu: true,
      run: () => void snip(),
      show: screenOk && !isDisabled && !snipping,
    },
    {
      id: 'model',
      icon: <AppIcon icon={FEATURE_ICONS.model} />,
      label: tr('ui.knowledge-local.providers-models'),
      testId: 'open-providers',
      menu: true,
      run: () => openModels(),
      show: true,
    },
    {
      id: 'voice',
      icon: <AppIcon icon={FEATURE_ICONS.voice} />,
      label: tr('ui.knowledge-local.voice-settings'),
      hint: tr('ui.knowledge-local.f2-to-talk'),
      testId: 'open-voice-settings',
      run: () => cv.setShowSettings(true),
      show: cv.v.available,
    },
    {
      id: 'hub',
      icon: <AppIcon icon={FEATURE_ICONS.hub} />,
      label: tr('ui.chat-settings.knowledge-memory-schedule'),
      hint: formatCombo(bindings.hub),
      testId: 'open-hub-panel',
      run: () => onHubClick?.(),
      show: !!onHubClick && (kbAvailable || memClient.available() || schedClient.available()),
    },
    {
      id: 'screen',
      icon: <AppIcon icon={FEATURE_ICONS.screen} />,
      label: tr('ui.knowledge-local.screenshots-screen-memory'),
      hint: formatCombo(bindings.screen),
      testId: 'open-screen-panel',
      run: () => onScreenClick?.(),
      show: !!onScreenClick && screenOk,
    },
    {
      id: 'ext',
      icon: <AppIcon icon={FEATURE_ICONS.ext} />,
      label: tr('ui.foundation.extensions-mcp-skills'),
      hint: formatCombo(bindings.ext),
      testId: 'open-ext-panel',
      run: () => onExtClick?.(),
      show: !!onExtClick && extClient.available(),
    },
    {
      id: 'desktop',
      icon: <AppIcon icon={FEATURE_ICONS.desktop} />,
      label: tr('ui.foundation.desktop-abilities'),
      testId: 'open-desktop-panel',
      run: () => onDesktopClick?.(),
      show: !!onDesktopClick,
    },
    {
      id: 'local',
      icon: <AppIcon icon={FEATURE_ICONS.local} />,
      label: tr('ui.knowledge-local.local-hub-helpers'),
      hint: formatCombo(bindings.local),
      testId: 'open-local-panel',
      run: () => onLocalClick?.(),
      show: !!onLocalClick && extClient.available(),
    },
    {
      id: 'settings',
      icon: <AppIcon icon={FEATURE_ICONS.settings} />,
      label: tr('ui.knowledge-local.all-settings'),
      hint: formatCombo(bindings.settings),
      testId: 'composer-settings',
      run: () => onSettingsClick?.(),
      show: !!onSettingsClick,
      menu: true,
    },
  ];
  // allCommands 的 run 函数捕获了 textareaRef / busyRef 等事件处理用的 ref，
  // react-hooks/refs 据此把整个数组推断为 ref-like，这里是事件处理层的派生，豁免

  const commands: Cmd[] = allCommands.filter((c) => c.show);
  // 输入框自带的界面命令 → 统一命令模型（「供应商与模型」改名 /providers，把 /model 让给原生的模型切换）
  const uiSlash: SlashCommand[] = commands.map((c) => ({
    id: `ui:${c.id}`,
    name: c.id === 'model' ? 'providers' : c.id,
    label: tr(c.label),
    description: tr(c.label),
    source: 'ui',
    kind: 'ui',
    run: () => {
      c.run();
      return { type: 'noop' };
    },
  }));
  const getRegistry = () => (slash ? slash.compose(uiSlash) : buildRegistry(uiSlash));
  const inSlash = message.startsWith('/');
  const registry = inSlash ? getRegistry() : [];
  const slashQuery = paletteQuery(message);
  const slashGroups = slashQuery === null ? [] : searchCommands(registry, slashQuery);
  const slashFlat = flattenGroups(slashGroups);
  const blockedSlash =
    slashQuery &&
    slashFlat.length === 0 &&
    findCommand(registry, slashQuery)?.kind === 'unsupported'
      ? slashQuery
      : undefined;
  const slashOpen = slashQuery !== null && (slashFlat.length > 0 || (!!slash && slashQuery !== ''));
  const agentQuery = slash ? agentArgQuery(message, registry) : null;
  const agentOptions = agentQuery === null ? [] : filterAgents(agentInstalled, agentQuery);
  const agentOpen = agentQuery !== null && agentClosed !== message;
  function pickAgent(o: AgentOption) {
    const a = argPhase(message);
    if (!a) return;
    setMessage(`/${a.name} ${o.id} `);
    setAgentIdx(0);
    textareaRef.current?.focus();
  }
  const agentPhase = agentQuery !== null;
  useEffect(() => {
    if (!agentPhase || !delegateClient.available()) return;
    let live = true;
    void delegateClient
      .settings()
      .then((v) => live && setAgentInstalled(Array.isArray(v?.installed) ? v.installed : []))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [agentPhase]);
  const argState = slash ? argPhase(message) : null;
  const argCmd = argState ? findCommand(registry, argState.name) : null;
  // 命令名已定、正在输参数：显示参数提示
  const argHint = argCmd?.args && !argCmd.disabled && !argState?.args && !agentOpen ? argCmd : null;
  function runCommand(c: Cmd | undefined) {
    if (!c) return;
    setMenuOpen(false);
    setMessage('');
    c.run();
  }
  /** 从面板选中命令：需要参数的先补全成 `/name `，其余直接执行 */
  function pickCommand(c: SlashCommand, mode: 'run' | 'complete') {
    // 被禁用的同名项没有可补的参数：直接执行，让执行层给出不能发送的说明
    const needsArgs =
      !c.disabled &&
      !!c.args &&
      (c.kind === 'passthrough' || c.kind === 'expand' || c.args.hint.startsWith('<'));
    if (mode === 'complete' || (needsArgs && slash)) {
      setMessage(`/${c.name} `);
      setSlashIdx(0);
      textareaRef.current?.focus();
      return;
    }
    setMenuOpen(false);
    setMessage('');
    if (slash) void slash.run(`/${c.name}`, getRegistry());
    else void c.run('', undefined as never);
  }
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onEsc = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onEsc);
    };
  }, [menuOpen]);

  const renderItems = (list: Cmd[]) =>
    list.map((c) => (
      <button
        key={c.id}
        type="button"
        role="menuitem"
        className={styles.menuItem}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => runCommand(c)}
        data-testid={c.testId}
        aria-pressed={c.active}
        title={tr(c.label)}
      >
        <span className={styles.menuIcon}>{c.icon}</span>
        <span className={styles.menuLabel}>{tr(c.label)}</span>
        <span className={styles.menuHint}>{tr(c.hint)}</span>
      </button>
    ));

  return (
    <div className={styles.messageInputContainer}>
      {chatError && (
        <ErrorHint
          error={chatError}
          onDismiss={() => dispatch({ type: 'SET_ERROR', payload: undefined })}
        />
      )}

      <div className={styles.voiceRow}>
        <VoiceStatusRow cv={cv} />
      </div>
      <PermissionTip />
      {viewing && images.some((x) => x.id === viewing.id) && (
        <ImageLightbox image={viewing} onClose={closeViewer} />
      )}
      {contextMessages?.length ? <ComposerChangesPill messages={contextMessages} /> : null}
      <div className={`${styles.inputWrapper} ${dragOver ? styles.dragOver : ''}`}>
        {slashOpen && (
          <SlashPalette
            groups={slashGroups}
            active={Math.min(slashIdx, Math.max(0, slashFlat.length - 1))}
            query={slashQuery ?? ''}
            {...(blockedSlash ? { blocked: blockedSlash } : {})}
            onPick={(c) => pickCommand(c, 'run')}
            onHover={setSlashIdx}
          />
        )}
        {agentOpen && (
          <AgentPalette
            options={agentOptions}
            active={Math.min(agentIdx, Math.max(0, agentOptions.length - 1))}
            onPick={pickAgent}
            onHover={setAgentIdx}
          />
        )}
        {argHint?.args && (
          <div className={styles.slashHint} data-testid="slash-arg-hint">
            <code>
              /{argHint.name} {argHint.args.hint}
            </code>
            <span>{argHint.description}</span>
          </div>
        )}
        {(images.length > 0 || files.length > 0 || imgErr) && (
          <div className={styles.attachRow} data-testid="attach-row">
            {images.map((i) => (
              <div key={i.id} className={styles.attachItem} title={`${i.width}×${i.height}`}>
                <button
                  type="button"
                  className={styles.attachOpen}
                  aria-label={tr('ui.knowledge-local.view-image')}
                  data-testid="attach-open"
                  onClick={() => setViewing(i)}
                >
                  <img
                    src={i.thumb}
                    alt={tr('ui.knowledge-local.attached-image')}
                    className={styles.attachThumb}
                  />
                </button>
                <button
                  type="button"
                  className={styles.attachRemove}
                  aria-label={tr('ui.knowledge-local.remove-image')}
                  onClick={() => setImages((c) => c.filter((x) => x.id !== i.id))}
                >
                  <Icon icon={X} size={12} />
                </button>
              </div>
            ))}
            {files.map((f) => (
              <FileChip
                key={f.id}
                file={f}
                onRemove={() => setFiles((c) => c.filter((x) => x.id !== f.id))}
              />
            ))}
            <div className={styles.attachMeta}>
              {imgErr ? (
                <span className={styles.attachErr}>{imgErr}</span>
              ) : visionWarn ? (
                <span className={styles.attachWarn} data-testid="vision-warn">
                  {imageCapability === 'none'
                    ? (imageUnsupportedReason ??
                      tr('ui.session-workspace.the-current-model-doesn-t-support-images-remove'))
                    : tr('ui.knowledge-local.the-current-model-may-not-support-images-consider')}
                </span>
              ) : images.length ? (
                <span className={styles.attachHint}>
                  {tr('ui.knowledge-local.images-are-sent-with-this-message-originals-aren')}
                </span>
              ) : null}
            </div>
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={message}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onPaste={(e) => {
            if (takeFiles(Array.from(e.clipboardData.files))) e.preventDefault();
          }}
          placeholder={
            queue && busy
              ? tr('ui.usage-tools.running-keep-typing-to-queue-it-will-send')
              : busyOverride !== undefined
                ? placeholder
                : kbMode && kbAvailable
                  ? tr('ui.knowledge-local.ask-the-knowledge-base-answers-include-citations')
                  : placeholder
          }
          disabled={isDisabled}
          className={styles.messageTextarea}
          aria-label={tr('ui.mascot-theme.message-input')}
          data-testid="chat-input"
          rows={1}
        />

        <div className={styles.composerBar} data-testid="composer-bar">
          <div className={styles.composerLeft} data-zone="left">
            <div className={styles.moreWrap} ref={menuRef}>
              <button
                type="button"
                className={styles.iconButton}
                onClick={() => setMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                title={tr('ui.knowledge-local.more-knowledge-base-q-a-screenshot-models-settings')}
                aria-label={tr('ui.knowledge-local.more')}
                data-testid="composer-more"
              >
                <Icon icon={Plus} />
              </button>
              {menuOpen && (
                <div className={styles.menu} role="menu" data-testid="composer-menu">
                  {renderItems(commands.filter((c) => c.menu))}
                </div>
              )}
            </div>
            {kbMode && kbAvailable && (
              <button
                type="button"
                className={styles.chip}
                onClick={toggleKb}
                title={tr('ui.knowledge-local.knowledge-base-q-a-is-on-click-to')}
                data-testid="kb-mode-chip"
              >
                <Icon icon={BookOpen} size={14} />
                {tr('ui.foundation.knowledge-base')}
              </button>
            )}
            {nextDelegate && (
              <button
                type="button"
                className={styles.chip}
                onClick={() => setNextDelegate(null)}
                title={tr(
                  'ui.session-workspace.your-next-request-goes-to-click-to-cancel',
                  tr(ENDPOINT_NAME[nextDelegate]),
                )}
                aria-label={tr(
                  'ui.session-workspace.cancel-next-request-goes-to',
                  tr(ENDPOINT_NAME[nextDelegate]),
                )}
                data-testid="next-delegate-chip"
              >
                {tr('ui.session-workspace.to', tr(ENDPOINT_NAME[nextDelegate]))}
                <Icon icon={X} size={12} />
              </button>
            )}
            {onPluginsClick && (
              <button
                type="button"
                className={styles.iconButton}
                onClick={onPluginsClick}
                title={tr('ui.slash-commands.plugins-commands-commands-skills-plugins-and-mcp-for')}
                aria-label={tr('ui.slash-commands.plugins-commands')}
                data-testid="plugin-panel-open"
              >
                <Icon icon={Blocks} size={16} />
              </button>
            )}
            <div className={styles.modelStatus}>
              <EndpointControls />
            </div>
          </div>
          <div className={styles.composerRight} data-zone="right">
            <VoiceButtons cv={cv} disabled={disabled} />
            {contextMessages?.length ? (
              <ContextUsageBar messages={contextMessages} model={contextModel} />
            ) : null}
            {canStop ? (
              <button
                type="button"
                onClick={stopFn}
                className={styles.sendButton}
                title={tr('ui.usage-tools.stop-generating')}
                aria-label={tr('ui.usage-tools.stop-generating')}
                data-testid="stop-button"
              >
                <Icon icon={Square} />
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={isDisabled || (!message.trim() && !images.length && !files.length)}
                className={styles.sendButton}
                title={
                  queue && busy
                    ? tr('ui.usage-tools.queue-message-enter')
                    : tr('ui.knowledge-local.send-message-enter')
                }
                aria-label={
                  queue && busy ? tr('ui.usage-tools.queue') : tr('ui.knowledge-local.send')
                }
                data-testid={queue && busy ? 'queue-button' : 'send-button'}
              >
                {queue && busy ? (
                  <Icon icon={ListPlus} />
                ) : busy ? (
                  <div className={styles.loadingSpinner} />
                ) : (
                  <Icon icon={ArrowUp} />
                )}
              </button>
            )}
          </div>
        </div>
      </div>
      <VoiceSettingsModal cv={cv} />
    </div>
  );
};

/** Memoized: App rerenders (tabs, panels) do not rerender the composer unless its props change. */
export const MessageInput = memo(MessageInputImpl);
