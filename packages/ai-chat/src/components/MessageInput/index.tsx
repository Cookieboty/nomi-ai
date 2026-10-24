import { createLogger, t as tr, Icon } from '@nomi-ai/ui';
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
import { setNextDelegate } from '../../services/delegateClient';
import { extClient } from '../../services/extClient';
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
import { argPhase, paletteQuery } from '../../slash/parse';
import { buildRegistry, findCommand, flattenGroups, searchCommands } from '../../slash/registry';
import type { SlashBridge, SlashCommand } from '../../slash/types';
import type { ConvMessage } from '../../types/conversation';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { CYCLE_PERMISSION_EVENT, type CyclePermissionDetail } from '../../utils/permissionModes';
import { AppIcon, FEATURE_ICONS } from '../AppIcons';
import { EndpointControls, PermissionTip } from '../EndpointControls';
import { ErrorHint } from '../ErrorHint';
import { ComposerChangesPill } from '../SessionWorkspace/ComposerChangesPill';
import { ContextUsageBar } from '../SessionWorkspace/ContextUsageBar';
import type { SettingsSection } from '../SettingsView/sections';
import { SlashPalette } from '../SlashPalette';
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
  placeholder = tr('输入消息...'),
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
  const bindings = useShortcutBindings();
  const [message, setMessage] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [slashIdx, setSlashIdx] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const [isComposing, setIsComposing] = useState(false);
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
      if (next.length > MAX_ATTACHMENTS) setImgErr(tr('最多附 {0} 张图片', MAX_ATTACHMENTS));
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
  const snip = useCallback(async () => {
    if (!screenOk || snipping) return;
    setSnipping(true);
    setImgErr('');
    try {
      const a = await screenClient.snip();
      if (a) {
        addImages([a]);
        if (!textareaRef.current?.value) setMessage(tr('这张截图里是什么？'));
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
        setMessage((m) => m || tr('这张截图里是什么？'));
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
  const visionWarn = images.length > 0 && !(visionKnown ?? likelyVision(chatModel));

  const handleSend = async () => {
    let trimmedMessage = message.trim() || (images.length ? tr('请看看这张图片。') : '');
    if (!trimmedMessage) return;
    // 斜杠命令：原生命令 / 未知命令 / 自定义命令都在这里被接管；`//x` 转义成普通文字 `/x`
    if (slash && !images.length && trimmedMessage.startsWith('/')) {
      const scopeAtStart = slash.scope?.();
      const r = await slash.run(trimmedMessage, getRegistry());
      if (r.handled) {
        // 命令是异步的：完成时用户若已切到别的会话，输入框里是那边的草稿，不能清掉
        if (scopeAtStart === undefined || slash.scope?.() === scopeAtStart) setMessage('');
        return;
      }
      if (r.text !== undefined) trimmedMessage = r.text;
    }
    if (busy) {
      // 运行中：文字消息进队列（带图片的消息不排队，等当前轮结束再发）
      if (queue && !images.length) {
        // 入队时冻结知识库模式：排队期间切换开关不改变这条消息的去向
        if (kbMode && kbAvailable) queue.onQueue(trimmedMessage, { kb: true });
        else queue.onQueue(trimmedMessage);
        setMessage('');
      }
      return;
    }
    const sendImages = images;

    try {
      setMessage('');
      setImages([]);
      setImgErr('');
      if (sendImages.length && imageCapability === 'none') {
        setImgErr(imageUnsupportedReason ?? tr('当前模型不支持图片，请去掉图片后再发。'));
        setImages(sendImages);
        setMessage(trimmedMessage);
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
    if (isComposing) return;

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
  const canStop = !!stopFn && busy && (!queue || (!message.trim() && !images.length));

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
      label: kbMode ? tr('知识库问答：开') : tr('知识库问答：关'),
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
      label: tr('截图提问'),
      hint: formatCombo(bindings.snip),
      testId: 'snip-button',
      menu: true,
      run: () => void snip(),
      show: screenOk && !isDisabled && !snipping,
    },
    {
      id: 'model',
      icon: <AppIcon icon={FEATURE_ICONS.model} />,
      label: tr('供应商与模型'),
      testId: 'open-providers',
      menu: true,
      run: () => openModels(),
      show: true,
    },
    {
      id: 'voice',
      icon: <AppIcon icon={FEATURE_ICONS.voice} />,
      label: tr('语音设置'),
      hint: tr('F2 说话'),
      testId: 'open-voice-settings',
      run: () => cv.setShowSettings(true),
      show: cv.v.available,
    },
    {
      id: 'hub',
      icon: <AppIcon icon={FEATURE_ICONS.hub} />,
      label: tr('知识 · 记忆 · 日程'),
      hint: formatCombo(bindings.hub),
      testId: 'open-hub-panel',
      run: () => onHubClick?.(),
      show: !!onHubClick && (kbAvailable || memClient.available() || schedClient.available()),
    },
    {
      id: 'screen',
      icon: <AppIcon icon={FEATURE_ICONS.screen} />,
      label: tr('截图与屏幕记忆'),
      hint: formatCombo(bindings.screen),
      testId: 'open-screen-panel',
      run: () => onScreenClick?.(),
      show: !!onScreenClick && screenOk,
    },
    {
      id: 'ext',
      icon: <AppIcon icon={FEATURE_ICONS.ext} />,
      label: tr('扩展：MCP 与技能'),
      hint: formatCombo(bindings.ext),
      testId: 'open-ext-panel',
      run: () => onExtClick?.(),
      show: !!onExtClick && extClient.available(),
    },
    {
      id: 'desktop',
      icon: <AppIcon icon={FEATURE_ICONS.desktop} />,
      label: tr('桌面能力'),
      testId: 'open-desktop-panel',
      run: () => onDesktopClick?.(),
      show: !!onDesktopClick,
    },
    {
      id: 'local',
      icon: <AppIcon icon={FEATURE_ICONS.local} />,
      label: tr('本地中心（辅助）'),
      hint: formatCombo(bindings.local),
      testId: 'open-local-panel',
      run: () => onLocalClick?.(),
      show: !!onLocalClick && extClient.available(),
    },
    {
      id: 'settings',
      icon: <AppIcon icon={FEATURE_ICONS.settings} />,
      label: tr('全部设置…'),
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
  const argState = slash ? argPhase(message) : null;
  const argCmd = argState ? findCommand(registry, argState.name) : null;
  // 命令名已定、正在输参数：显示参数提示
  const argHint = argCmd?.args && !argCmd.disabled && !argState?.args ? argCmd : null;
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
      {contextMessages ? <ComposerChangesPill messages={contextMessages} /> : null}
      <div
        className={`${styles.inputWrapper} ${dragOver ? styles.dragOver : ''}`}
        onDragOver={(e) => {
          if (Array.from(e.dataTransfer.items).some((it) => it.type.startsWith('image/'))) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          setDragOver(false);
          const files = Array.from(e.dataTransfer.files);
          if (files.some((f) => f.type.startsWith('image/'))) {
            e.preventDefault();
            void addFiles(files);
          }
        }}
      >
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
        {argHint?.args && (
          <div className={styles.slashHint} data-testid="slash-arg-hint">
            <code>
              /{argHint.name} {argHint.args.hint}
            </code>
            <span>{argHint.description}</span>
          </div>
        )}
        {(images.length > 0 || imgErr) && (
          <div className={styles.attachRow} data-testid="attach-row">
            {images.map((i) => (
              <div key={i.id} className={styles.attachItem} title={`${i.width}×${i.height}`}>
                <button
                  type="button"
                  className={styles.attachOpen}
                  aria-label={tr('查看图片')}
                  data-testid="attach-open"
                  onClick={() => setViewing(i)}
                >
                  <img src={i.thumb} alt={tr('附件图片')} className={styles.attachThumb} />
                </button>
                <button
                  type="button"
                  className={styles.attachRemove}
                  aria-label={tr('移除图片')}
                  onClick={() => setImages((c) => c.filter((x) => x.id !== i.id))}
                >
                  <Icon icon={X} size={12} />
                </button>
              </div>
            ))}
            <div className={styles.attachMeta}>
              {imgErr ? (
                <span className={styles.attachErr}>{imgErr}</span>
              ) : visionWarn ? (
                <span className={styles.attachWarn} data-testid="vision-warn">
                  {tr('当前模型可能不支持看图，建议切换到视觉模型（如 qwen2.5vl、llava、gpt-4o）')}
                </span>
              ) : (
                <span className={styles.attachHint}>
                  {tr('图片将随这条消息发送 · 原图不会保存在聊天记录里')}
                </span>
              )}
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
            const files = Array.from(e.clipboardData.files);
            if (files.some((f) => f.type.startsWith('image/'))) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
          placeholder={
            queue && busy
              ? tr('运行中，继续输入会排队，完成后自动发送…')
              : busyOverride !== undefined
                ? placeholder
                : kbMode && kbAvailable
                  ? tr('向知识库提问，回答会标注出处…')
                  : placeholder
          }
          disabled={isDisabled}
          className={styles.messageTextarea}
          aria-label={tr('消息输入框')}
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
                title={tr('更多：知识库问答、截图、模型、设置（也可输入 / ）')}
                aria-label={tr('更多功能')}
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
                title={tr('知识库问答已开启，点击关闭')}
                data-testid="kb-mode-chip"
              >
                <Icon icon={BookOpen} size={14} />
                {tr('知识库')}
              </button>
            )}
            {nextDelegate && (
              <button
                type="button"
                className={styles.chip}
                onClick={() => setNextDelegate(null)}
                title={tr('下一个需求交给 {0}，点击取消', tr(ENDPOINT_NAME[nextDelegate]))}
                aria-label={tr('取消：下一个需求交给 {0}', tr(ENDPOINT_NAME[nextDelegate]))}
                data-testid="next-delegate-chip"
              >
                {tr('交给 {0}', tr(ENDPOINT_NAME[nextDelegate]))}
                <Icon icon={X} size={12} />
              </button>
            )}
            {onPluginsClick && (
              <button
                type="button"
                className={styles.iconButton}
                onClick={onPluginsClick}
                title={tr('插件 / 命令：当前端的命令、Skills、插件、MCP（也可输入 /）')}
                aria-label={tr('插件 / 命令')}
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
            {contextMessages ? (
              <ContextUsageBar messages={contextMessages} model={contextModel} />
            ) : null}
            {canStop ? (
              <button
                type="button"
                onClick={stopFn}
                className={styles.sendButton}
                title={tr('停止生成')}
                aria-label={tr('停止生成')}
                data-testid="stop-button"
              >
                <Icon icon={Square} />
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={isDisabled || (!message.trim() && !images.length)}
                className={styles.sendButton}
                title={queue && busy ? tr('排队发送 (Enter)') : tr('发送消息 (Enter)')}
                aria-label={queue && busy ? tr('排队') : tr('发送')}
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
