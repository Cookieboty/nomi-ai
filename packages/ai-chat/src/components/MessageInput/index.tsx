import { createLogger, t as tr, Icon, useLocale } from '@nomi-ai/ui';
import { BookOpen, X, ArrowUp, ListPlus, Square } from 'lucide-react';
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
  selectBusyHere,
  selectStreamingHere,
  useAiChatActions,
  useAiChatSelector,
} from '../../contexts/aiChatStore';
import { useComposerDraftBinding } from '../../hooks/useComposerDraftBinding';
import { useNextDelegate } from '../../hooks/useNextDelegate';
import { isGoHost, onHostOnlyFiles, type HostDroppedFile } from '../../services/api';
import { SHARED_UNSENT, createComposerDraftStore } from '../../services/composerDrafts';
import { delegateClient, setNextDelegate, type DelegateCli } from '../../services/delegateClient';
import { extClient } from '../../services/extClient';
import {
  MAX_FILE_ATTACHMENTS,
  fetchHostFile,
  fileAttachmentFrom,
  fileAttachmentFromHost,
  isImagePath,
  joinFileAttachments,
  type FileAttachment,
} from '../../services/fileAttachments';
import { memClient } from '../../services/memClient';
import { nomiModelLabel, nomiModelMeta } from '../../services/nomiModel';
import { schedClient } from '../../services/schedClient';
import {
  MAX_ATTACHMENTS,
  attachmentFromFile,
  likelyVision,
  type ImageAttachment,
} from '../../services/screenClient';
import {
  formatCombo,
  getBindings,
  matchShortcut,
  useShortcutBindings,
} from '../../services/shortcuts';
import { agentArgQuery, filterAgents, type AgentOption } from '../../slash/agentComplete';
import {
  atPathToken,
  filterAtPathOptions,
  formatAtPathInsert,
  replaceAtPathToken,
  type AtPathOption,
} from '../../slash/atPathComplete';
import { filterModelOptions, modelArgQuery } from '../../slash/modelComplete';
import { argPhase, paletteQuery } from '../../slash/parse';
import { buildRegistry, findCommand, flattenGroups, searchCommands } from '../../slash/registry';
import type { ModelArgOption, SlashBridge, SlashCommand } from '../../slash/types';
import { useAtPathOptions } from '../../slash/useAtPathOptions';
import type { ConvMessage } from '../../types/conversation';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { isImeComposing, moveTextareaToLineBoundary } from '../../utils/keyboard';
import type { PendingMode } from '../../utils/pendingSends';
import { CYCLE_PERMISSION_EVENT, type CyclePermissionDetail } from '../../utils/permissionModes';
import { AppIcon, FEATURE_ICONS } from '../AppIcons';
import { AtPathPalette } from '../AtPathPalette';
import { EndpointControls, PermissionTip } from '../EndpointControls';
import { ErrorHint } from '../ErrorHint';
import { FileChip } from '../FileAttachment';
import { ComposerChangesPill } from '../SessionWorkspace/ComposerChangesPill';
import { ContextUsageBar } from '../SessionWorkspace/ContextUsageBar';
import type { SettingsSection } from '../SettingsView/sections';
import { AgentPalette, ModelArgPalette, SlashPalette } from '../SlashPalette';
import { VoiceButtons, VoiceSettingsModal, VoiceStatusRow, useChatVoice } from '../VoiceInput';

import { ComposerReferenceLinks } from './ComposerReferenceLinks';
import { ImageLightbox } from './ImageLightbox';
import styles from './index.module.css';
import { PlusMenu } from './PlusMenu';
import type { MessageInputProps } from './types';
import { useAutoHeight } from './useAutoHeight';
import { useCompactComposerLayout } from './useCompactComposerLayout';
import { useKnowledgeMode } from './useKnowledgeMode';
import { useReferenceDraft } from './useReferenceDraft';

const log = createLogger('message-input');

/** 发文框随内容长高（Codex 式）：空着时两行高（14px × 1.6 行高，一行字 + 留白），超过 COMPOSER_MAX 后框内滚动。 */
export const COMPOSER_MIN_HEIGHT_PX = 44;
export const COMPOSER_MAX_HEIGHT_PX = 240;

const MessageInputImpl: React.FC<MessageInputProps> = ({
  onSend,
  busyOverride,
  imageCapability,
  imageUnsupportedReason,
  placeholder = tr('ui.knowledge-local.type-a-message'),
  queue,
  disabled = false,
  compact = false,
  floating = false,
  onProvidersClick,
  onDesktopClick,
  onHubClick,
  onExtClick,
  onLocalClick,
  onSettingsClick,
  slash,
  onPluginsClick,
  contextMessages,
  contextModel,
  fill,
  cwd,
  roots,
  delegate,
  draftStore,
  draftKey,
}) => {
  // 语言切换时重渲染：memo 挡住了根组件的更新，这里自己订阅（#140）
  useLocale();
  const bindings = useShortcutBindings();
  // 单测等未传 draftStore 时用组件内私有桶，行为等同原来的本地 useState
  const localDraftStore = useRef(createComposerDraftStore()).current;
  const activeDraftStore = draftStore ?? localDraftStore;
  const activeDraftKey = draftKey ?? SHARED_UNSENT;
  const {
    text: rawDraft,
    setText: setRawDraft,
    images,
    setImages,
    files,
    setFiles,
    clearActive,
  } = useComposerDraftBinding(activeDraftStore, activeDraftKey);
  const linkedDraft = useReferenceDraft(rawDraft, setRawDraft);
  const { text: message, setText: setMessage } = linkedDraft;
  const [menuOpen, setMenuOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [slashIdx, setSlashIdx] = useState(0);
  const [isComposing, setIsComposing] = useState(false);
  const [agentIdx, setAgentIdx] = useState(0);
  /** `/model ` 补全：候选（null = 还在读）、高亮项、按 Esc 关掉时的输入 */
  const [modelOpts, setModelOpts] = useState<ModelArgOption[] | null>(null);
  const [modelIdx, setModelIdx] = useState(0);
  const [modelClosed, setModelClosed] = useState<string | null>(null);
  /** 按 Esc 关掉助手列表时的输入；输入一变就重新出现 */
  const [agentClosed, setAgentClosed] = useState<string | null>(null);
  /** `/agent ` 补全用的已安装编程助手（委派设置里的检测结果）；null = 还没读到 */
  const [agentInstalled, setAgentInstalled] = useState<DelegateCli[] | null>(null);
  /** @ 路径补全：光标、高亮项、Esc 关闭快照、已缓存的工作区树 */
  const [caret, setCaret] = useState(0);
  const [atIdx, setAtIdx] = useState(0);
  const [atClosed, setAtClosed] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const multiline = useCompactComposerLayout(textareaRef, message, compact && floating);
  const newlineCaret = useRef<number | null>(null);
  // 列向 flex 里 flex:1 的基准高度是 0，行内 height 不生效，所以这里按内容写回，并封顶。
  useAutoHeight(
    textareaRef,
    message,
    compact || floating ? 24 : COMPOSER_MIN_HEIGHT_PX,
    COMPOSER_MAX_HEIGHT_PX,
  );
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el || newlineCaret.current === null) return;
    const caret = newlineCaret.current;
    newlineCaret.current = null;
    el.setSelectionRange(caret, caret);
    if (caret === el.value.length) el.scrollTop = el.scrollHeight;
  }, [message]);
  // 挂载时已有的请求视为处理过（切标签重挂载不再重复填入）
  const seenFill = useRef(fill?.nonce);
  const fillNonce = fill?.nonce;
  useEffect(() => {
    if (!fill || fill.nonce === seenFill.current) return;
    seenFill.current = fill.nonce;
    linkedDraft.append(fill.text);
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
  // 只看当前展示的会话：别的会话在回复时，这里照常可以发送，也不显示停止键
  const isLoading = useAiChatSelector(selectBusyHere);
  const streaming = useAiChatSelector(selectStreamingHere);
  const chatError = useAiChatSelector(selectError);
  // 知识库问答模式（Ctrl/Cmd+Shift+K 切换），记住上次的选择
  // `/cli 名字`：下一个需求交给哪个编程助手（输入栏上的 chip，点 × 取消）
  const nextDelegate = useNextDelegate();
  const { kbMode, kbAvailable, toggleKb } = useKnowledgeMode(textareaRef);

  // ───── 图片附件：粘贴 / 拖入（images/files 由 draft binding 持有）─────
  /** 点缩略图放大查看的那张 */
  const [viewing, setViewing] = useState<ImageAttachment | null>(null);
  const closeViewer = useCallback(() => setViewing(null), []);
  const [imgErr, setImgErr] = useState('');
  const [dragOver, setDragOver] = useState(false);
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
  // Go 版在 macOS / Linux 上：原生拖放层接走了 drop，只有宿主送来的路径（services/api.ts onHostOnlyFiles）
  const takeHostFiles = useCallback(
    async (list: HostDroppedFile[]) => {
      const imgs = list.filter((f) => isImagePath(f.name) && f.url);
      const others = list.filter((f) => !imgs.includes(f));
      if (imgs.length) {
        const read = await Promise.all(imgs.map(fetchHostFile));
        const ok = read.filter((f): f is File => !!f);
        for (const f of imgs.filter((_, i) => !read[i]))
          setImgErr(tr('ui.knowledge-local.can-t-read-file', f.name));
        if (ok.length) void addFiles(ok);
      }
      if (!others.length) return;
      const out = await Promise.all(others.map(fileAttachmentFromHost));
      setFiles((cur) => {
        const next = [...cur, ...out];
        if (next.length > MAX_FILE_ATTACHMENTS)
          setImgErr(tr('ui.knowledge-local.up-to-files', MAX_FILE_ATTACHMENTS));
        return next.slice(0, MAX_FILE_ATTACHMENTS);
      });
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    [addFiles],
  );
  const takeHostFilesRef = useRef(takeHostFiles);
  useLayoutEffect(() => {
    takeHostFilesRef.current = takeHostFiles;
  }, [takeHostFiles]);
  useEffect(
    () =>
      onHostOnlyFiles((list) => {
        setDragOver(false);
        void takeHostFilesRef.current(list);
      }),
    [],
  );
  // 同样的原因网页收不到 dragover：Wails 在拖动经过时给 body 加 file-drop-target-active，据此高亮输入框
  useEffect(() => {
    if (!isGoHost() || typeof MutationObserver === 'undefined' || !document.body) return;
    const body = document.body;
    const sync = () => setDragOver(body.classList.contains('file-drop-target-active'));
    const mo = new MutationObserver(sync);
    mo.observe(body, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, []);
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
  const chatModel = nomiModelLabel() ?? '';
  // 模型元数据写明了视觉能力就以它为准，否则按名字猜
  const visionKnown = nomiModelMeta()?.vision;
  // 编程助手标签由调用方给出发图能力（当前 CLI 模型），不能拿 Nomi 自己的模型去判断
  const visionWarn =
    images.length > 0 &&
    (imageCapability !== undefined
      ? imageCapability === 'none'
      : !(visionKnown ?? likelyVision(chatModel)));

  const handleSend = async (mode: PendingMode = 'steer') => {
    let trimmedMessage =
      linkedDraft.serialized.trim() ||
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
        if (scopeAtStart === undefined || slash.scope?.() === scopeAtStart) clearActive();
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
        if (kbMode && kbAvailable) queue.onQueue(trimmedMessage, { kb: true, mode });
        else queue.onQueue(trimmedMessage, { mode });
        clearActive();
      }
      return;
    }
    const sendImages = images;

    try {
      clearActive();
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
    if (isComposing || isImeComposing(e.nativeEvent)) return;

    // macOS / Windows 统一 Alt+Enter 换行；先处理，避免补全菜单把它当成执行。
    if (e.key === 'Enter' && e.altKey) {
      e.preventDefault();
      const el = e.currentTarget;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      newlineCaret.current = start + 1;
      setMessage(`${el.value.slice(0, start)}\n${el.value.slice(end)}`);
      return;
    }
    // Shift+Enter 使用文本域原生换行（包括撤销），不要被补全菜单截走。
    if (e.key === 'Enter' && e.shiftKey) return;
    if ((e.key === 'Home' || e.key === 'End') && !e.altKey) {
      e.preventDefault();
      moveTextareaToLineBoundary(e.currentTarget, e.key, e.shiftKey, e.ctrlKey || e.metaKey);
      return;
    }

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

    // `/model ` 后选模型：↑↓ 选择，Tab / Enter 补全模型名（再按 Enter 切换），Esc 关闭列表
    if (modelOpen) {
      const n = modelOptions.length;
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && n) {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        setModelIdx((i) => (i + d + n) % n);
        return;
      }
      const o = modelOptions[Math.min(modelIdx, n - 1)];
      // 已经敲全（如 `/model opus`）时 Enter 照常执行命令
      const typed = (modelQuery ?? '').toLowerCase();
      const exact = !!typed && modelOptions.some((x) => x.value.toLowerCase() === typed);
      if (o && ((e.key === 'Enter' && !e.shiftKey && !exact) || (e.key === 'Tab' && !e.shiftKey))) {
        e.preventDefault();
        pickModelArg(o);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setModelClosed(message);
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

    // `@` 路径补全：↑↓ 选择，Enter / Tab 插入 @path，Esc 关闭（不创建附件芯片）
    if (atOpen) {
      const n = atOptions.length;
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && n) {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        setAtIdx((i) => (i + d + n) % n);
        return;
      }
      const o = n ? atOptions[Math.min(atIdx, n - 1)] : undefined;
      if (o && ((e.key === 'Enter' && !e.shiftKey) || (e.key === 'Tab' && !e.shiftKey))) {
        e.preventDefault();
        pickAtPath(o);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setAtClosed(message);
        return;
      }
      // 没有匹配项时不拦 Enter / Tab：照常发送、挪焦点（否则「@ 结尾」的消息发不出去）
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

    // Ctrl/⌘+Enter 发送；运行中排队到当前轮结束后再发。
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      void handleSend('queue');
      return;
    }

    // Esc：运行中且待发列表非空 → 停止这一轮，待发消息合成一条马上发出
    if (e.key === 'Escape' && busy && queue?.onFlush && (queue.pending ?? 0) > 0) {
      e.preventDefault();
      queue.onFlush();
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

  const syncCaret = () => {
    const el = textareaRef.current;
    if (el != null) setCaret(el.selectionStart);
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setMessage(e.target.value);
    setCaret(e.target.selectionStart ?? e.target.value.length);
    setSlashIdx(0);
    setAgentIdx(0);
    setAtIdx(0);
    // 刚敲下一个新的 `@`：重新读工作区树（文件可能刚被助手改过）
    const tok = atPathToken(e.target.value, e.target.selectionStart ?? e.target.value.length);
    if (tok && tok.query === '' && e.target.value.length > message.length) atPaths.reload();
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
    !!stopFn &&
    busy &&
    (!queue || (!linkedDraft.serialized.trim() && !images.length && !files.length));

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
    /** ＋ 菜单里的第二层（不作 / 命令：「交给编程助手」用 `/agent`） */
    submenu?: 'delegate';
  };
  // 命令项的 run 函数捕获了 textareaRef 等用于事件处理，react-hooks/refs 对此过度推断，豁免此处
  const allCommands: Cmd[] = [
    {
      // 和拖入 / 粘贴走同一条路：图片作图片附件，其余作文件附件
      id: 'attach',
      icon: <AppIcon icon={FEATURE_ICONS.attach} />,
      label: tr('ui.knowledge-local.add-images-or-files'),
      testId: 'composer-attach',
      menu: true,
      run: () => fileInputRef.current?.click(),
      show: true,
    },
    {
      // 插入 `@` 打开工作区文件面板（只在有工作区时）
      id: 'mention',
      icon: <AppIcon icon={FEATURE_ICONS.mention} />,
      label: tr('ui.knowledge-local.reference-a-file-or-folder'),
      hint: '@',
      testId: 'composer-mention',
      menu: true,
      run: insertAt,
      show: !!cwd,
    },
    {
      // Nomi 对话：下一条交给哪个编程助手（与 `/agent` 同一个钉住，输入框上方显示「交给 X」）
      id: 'delegate',
      icon: <AppIcon icon={FEATURE_ICONS.delegate} />,
      label: tr('ui.slash-commands.hand-off-to-a-coding-assistant'),
      hint: '›',
      testId: 'composer-delegate',
      menu: true,
      // 由「+」菜单打开第二层，不直接执行
      run: () => undefined,
      submenu: 'delegate',
      show: !!delegate && delegateClient.available(),
    },
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
      id: 'model',
      icon: <AppIcon icon={FEATURE_ICONS.model} />,
      label: tr('ui.knowledge-local.providers-models'),
      testId: 'open-providers',
      run: () => openModels(),
      show: true,
    },
    {
      id: 'voice',
      icon: <AppIcon icon={FEATURE_ICONS.voice} />,
      // 识别还没配好时语音按钮不显示：「+」菜单里给一个去配置的入口
      label: cv.ready
        ? tr('ui.knowledge-local.voice-settings')
        : tr('ui.knowledge-local.set-up-voice-input'),
      hint: cv.ready ? tr('ui.knowledge-local.f2-to-talk') : undefined,
      testId: 'open-voice-settings',
      menu: !cv.ready,
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
      id: 'ext',
      icon: <AppIcon icon={FEATURE_ICONS.ext} />,
      label: tr('ui.foundation.extensions-mcp-skills'),
      hint: formatCombo(bindings.ext),
      testId: 'open-ext-panel',
      run: () => onExtClick?.(),
      show: !!onExtClick && extClient.available(),
    },
    {
      // 编程助手标签才有：CLI 自己装的命令 / Skills / 插件 / MCP / 子代理（Nomi 自己的在「扩展」里）
      id: 'plugins',
      icon: <AppIcon icon={FEATURE_ICONS.cliPlugins} />,
      label: tr('ui.slash-commands.plugins-commands'),
      testId: 'plugin-panel-open',
      menu: true,
      run: () => onPluginsClick?.(),
      show: !!onPluginsClick,
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
      label: tr('ui.knowledge-local.local-models'),
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
    },
  ];
  // allCommands 的 run 函数捕获了 textareaRef / busyRef 等事件处理用的 ref，
  // react-hooks/refs 据此把整个数组推断为 ref-like，这里是事件处理层的派生，豁免

  const commands: Cmd[] = allCommands.filter((c) => c.show);
  // 输入框自带的界面命令 → 统一命令模型（「供应商与模型」改名 /providers，把 /model 让给原生的模型切换）
  const uiSlash: SlashCommand[] = commands
    .filter((c) => !c.submenu)
    .map((c) => ({
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
  const modelQuery = slash ? modelArgQuery(message, registry) : null;
  const modelOptions = modelQuery === null ? [] : filterModelOptions(modelOpts, modelQuery);
  const modelOpen = modelQuery !== null && modelClosed !== message && !!slash?.modelOptions;
  function pickModelArg(o: ModelArgOption) {
    const a = argPhase(message);
    if (!a) return;
    setMessage(`/${a.name} ${o.value}`);
    setModelIdx(0);
    textareaRef.current?.focus();
  }
  // 进入 `/model ` 参数阶段时读一次候选（会话的模型目录 / 网关模型），离开时清掉
  const modelPhase = modelQuery !== null;
  const loadModelOptions = slash?.modelOptions;
  useEffect(() => {
    if (!modelPhase || !loadModelOptions) return;
    let live = true;
    void loadModelOptions()
      .then((v) => live && setModelOpts(v))
      .catch(() => live && setModelOpts([]));
    return () => {
      live = false;
      setModelOpts(null);
      setModelIdx(0);
    };
  }, [modelPhase, loadModelOptions]);
  const atToken = atPathToken(message, caret);
  const atOpen =
    !!cwd && atToken !== null && !slashOpen && !agentOpen && !modelOpen && atClosed !== message;
  const atPaths = useAtPathOptions(atOpen, cwd, roots);
  const atOptions = atToken ? filterAtPathOptions(atPaths.options, atToken.query) : [];

  function pickAtPath(o: AtPathOption) {
    const token = atPathToken(message, caret);
    if (!token) return;
    const insert = formatAtPathInsert(o);
    const next = replaceAtPathToken(message, token, insert);
    setMessage(next.text);
    setCaret(next.caret);
    setAtIdx(0);
    // Dismiss so caret at end of @path does not keep atOpen (mirrors Esc/atClosed)
    setAtClosed(next.text);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  }

  const argState = slash ? argPhase(message) : null;
  const argCmd = argState ? findCommand(registry, argState.name) : null;
  // 命令名已定、正在输参数：显示参数提示
  const argHint =
    argCmd?.args && !argCmd.disabled && !argState?.args && !agentOpen && !modelOpen ? argCmd : null;
  /** 「引用文件」：在光标处插入 `@`（前面不是空白时先补一个空格），打开工作区文件面板 */
  function insertAt() {
    const el = textareaRef.current;
    const at = el?.selectionStart ?? message.length;
    const before = message.slice(0, at);
    const ins = before && !/\s$/.test(before) ? ' @' : '@';
    const next = before + ins + message.slice(at);
    const pos = at + ins.length;
    setMessage(next);
    setCaret(pos);
    setAtIdx(0);
    atPaths.reload();
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
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
      {!compact && <PermissionTip />}
      {viewing && images.some((x) => x.id === viewing.id) && (
        <ImageLightbox image={viewing} onClose={closeViewer} />
      )}
      {contextMessages?.length ? <ComposerChangesPill messages={contextMessages} /> : null}
      <div
        className={`${styles.inputWrapper} ${compact ? styles.compact : ''} ${floating ? styles.floating : ''} ${multiline ? styles.multiline : ''} ${dragOver ? styles.dragOver : ''}`}
        data-compact={compact || undefined}
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
        {agentOpen && (
          <AgentPalette
            options={agentOptions}
            active={Math.min(agentIdx, Math.max(0, agentOptions.length - 1))}
            onPick={pickAgent}
            onHover={setAgentIdx}
          />
        )}
        {modelOpen && (
          <ModelArgPalette
            options={modelOpts === null ? null : modelOptions}
            active={Math.min(modelIdx, Math.max(0, modelOptions.length - 1))}
            onPick={pickModelArg}
            onHover={setModelIdx}
          />
        )}
        {atOpen && (
          <AtPathPalette
            options={atOptions}
            active={Math.min(atIdx, Math.max(0, atOptions.length - 1))}
            onPick={pickAtPath}
            onHover={setAtIdx}
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
        <ComposerReferenceLinks draft={linkedDraft} />
        <textarea
          ref={textareaRef}
          value={message}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onSelect={syncCaret}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onPaste={(e) => {
            if (takeFiles(Array.from(e.clipboardData.files))) e.preventDefault();
          }}
          placeholder={
            queue && busy
              ? tr('ui.usage-tools.running-enter-inserts-ctrl-enter-queues')
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
            <PlusMenu
              open={menuOpen}
              onOpenChange={setMenuOpen}
              items={commands.filter((c) => c.menu)}
              fileInputRef={fileInputRef}
              onFiles={takeFiles}
              onDelegate={(cli) => {
                setNextDelegate(cli);
                requestAnimationFrame(() => textareaRef.current?.focus());
              }}
            />
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
            {/* Codex 式：左边是 + 与权限模式，模型放到右边、挨着语音与发送 */}
            {!compact && (
              <div className={styles.modelStatus}>
                <EndpointControls part="mode" />
              </div>
            )}
          </div>
          <div className={styles.composerRight} data-zone="right">
            <div className={styles.modelStatus} data-testid="composer-model">
              <EndpointControls part="model" />
            </div>
            {compact && <EndpointControls part="mode" />}
            {!compact && <VoiceButtons cv={cv} disabled={disabled} />}
            {!compact && contextMessages?.length ? (
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
                onClick={() => void handleSend()}
                disabled={
                  isDisabled || (!linkedDraft.serialized.trim() && !images.length && !files.length)
                }
                className={styles.sendButton}
                title={
                  queue && busy
                    ? tr('ui.usage-tools.add-to-pending-enter')
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
