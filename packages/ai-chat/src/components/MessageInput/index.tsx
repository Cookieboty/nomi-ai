import { createLogger, t as tr, Icon } from '@nomi-ai/ui';
import { BookOpen, Blocks, Pin, X, ArrowUp, ListPlus, Plus, Square } from 'lucide-react';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  useRef,
  type KeyboardEvent,
} from 'react';

import { useAiChat } from '../../contexts/AiChatContext';
import { extClient } from '../../services/extClient';
import { kbClient } from '../../services/kbClient';
import { memClient } from '../../services/memClient';
import { MAX_PINS, pinDef, togglePin, usePins } from '../../services/pins';
import { effectiveProviderLabel } from '../../services/providerClient';
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
import { CYCLE_PERMISSION_EVENT, type CyclePermissionDetail } from '../../utils/permissionModes';
import { AppIcon, FEATURE_ICONS } from '../AppIcons';
import { EndpointControls } from '../EndpointControls';
import { ErrorHint } from '../ErrorHint';
import type { SettingsSection } from '../SettingsView/sections';
import { SlashPalette } from '../SlashPalette';
import { VoiceButtons, VoiceSettingsModal, VoiceStatusRow, useChatVoice } from '../VoiceInput';

import styles from './index.module.css';

const log = createLogger('message-input');

/** 发文框最高高度。再长的内容在框内滚动，不再把输入区撑高。 */
export const COMPOSER_MAX_HEIGHT_PX = 200;

interface MessageInputProps {
  onSend?: (message: string) => void;
  /** 独立于 Nomi 对话的忙碌状态（CLI 标签）；设置后不再看 Nomi 的 isLoading / 模型 */
  busyOverride?: boolean;
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
}

export const MessageInput: React.FC<MessageInputProps> = ({
  onSend,
  busyOverride,
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
}) => {
  const bindings = useShortcutBindings();
  const [message, setMessage] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const { pins, update: updatePins } = usePins();
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
    const next = Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT_PX);
    el.style.height = next > 0 ? `${next}px` : '';
  }, [message]);
  const { state, actions } = useAiChat();
  // 知识库问答模式（Ctrl/Cmd+Shift+K 切换），记住上次的选择
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
  const chatModel = effectiveProviderLabel() ?? '';
  const visionWarn = images.length > 0 && !likelyVision(chatModel);

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
      if (sendImages.length && busyOverride !== undefined) {
        setImgErr(tr('编程助手后端暂不支持图片，请切回 Nomi'));
        setImages(sendImages);
        setMessage(trimmedMessage);
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
    // Shift+Tab：切换编程助手的权限模式（同 Claude Code）；没有模式芯片时保持默认行为
    if (e.key === 'Tab' && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const detail: CyclePermissionDetail = { handled: false };
      window.dispatchEvent(new CustomEvent(CYCLE_PERMISSION_EVENT, { detail }));
      if (detail.handled) e.preventDefault();
      return;
    }
    // ↑ 在空输入框里找回上一条提问（同 Codex）
    if (e.key === 'ArrowUp' && !message) {
      const last = [...state.messages].reverse().find((m) => m.role === 'user');
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

  const busy = busyOverride ?? state.isLoading;
  const isDisabled =
    disabled ||
    (busyOverride !== undefined ? (queue ? false : busyOverride) : queue ? false : state.isLoading);

  // 停止：Nomi 流式生成中，或编程助手标签自带的停止；输入为空才显示（有字时发送键是「排队」）
  const stopFn =
    busyOverride === undefined
      ? state.streaming
        ? actions.stopGeneration
        : undefined
      : queue?.onStop;
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
  // 左上角常驻入口 / 其它地方通过 `cd:cmd` 事件触发同一套动作
  const cmdRef = useRef<{ list: Cmd[]; hf: () => void }>({ list: [], hf: () => undefined });
  // commands 每次渲染都是新引用，这里用 ref 缓存最新值供事件回调访问，不参与渲染

  cmdRef.current = { list: commands, hf: cv.toggleHandsFree };
  useEffect(() => {
    const on = (e: Event) => {
      const id = String((e as CustomEvent<string>).detail ?? '');
      if (id === 'handsfree') return void cmdRef.current.hf();
      cmdRef.current.list.find((c) => c.id === id)?.run();
    };
    window.addEventListener('cd:cmd', on);
    return () => window.removeEventListener('cd:cmd', on);
  }, []);
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
    list.map((c) => {
      const item = (
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
      );
      if (!pinDef(c.id)) return item;
      const pinned = pins.includes(c.id);
      const full = !pinned && pins.length >= MAX_PINS;
      return (
        <div key={c.id} className={styles.menuRow}>
          {item}
          <button
            type="button"
            className={`${styles.pinBtn} ${pinned ? styles.pinOn : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => updatePins(togglePin(pins, c.id))}
            disabled={full}
            title={
              pinned
                ? tr('取消固定')
                : full
                  ? tr('左上角最多 {0} 个', MAX_PINS)
                  : tr('固定到左上角')
            }
            aria-label={pinned ? tr('取消固定{0}', c.label) : tr('固定{0}到左上角', c.label)}
            aria-pressed={pinned}
            data-testid={`pin-toggle-${c.id}`}
          >
            <Icon icon={Pin} size={14} />
          </button>
        </div>
      );
    });

  return (
    <div className={styles.messageInputContainer}>
      {state.error && <ErrorHint error={state.error} />}

      <div className={styles.voiceRow}>
        <VoiceStatusRow cv={cv} />
      </div>
      {(images.length > 0 || imgErr) && (
        <div className={styles.attachRow} data-testid="attach-row">
          {images.map((i) => (
            <div key={i.id} className={styles.attachItem} title={`${i.width}×${i.height}`}>
              <img src={i.thumb} alt={tr('附件图片')} className={styles.attachThumb} />
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
              <EndpointControls
                className={styles.currentModel}
                onManageNomi={() => onProvidersClick?.()}
                onManageCli={(b) => onSettingsClick?.('coding', b)}
              />
            </div>
          </div>
          <div className={styles.composerRight} data-zone="right">
            <VoiceButtons cv={cv} disabled={disabled} />
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
