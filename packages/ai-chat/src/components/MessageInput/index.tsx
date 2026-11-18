import { t as tr, useLocale } from '@nomi-ai/ui';
import React, { memo, useCallback, useEffect, useLayoutEffect, useState, useRef } from 'react';

import {
  selectError,
  selectBusyHere,
  selectStreamingHere,
  useAiChatActions,
  useAiChatSelector,
} from '../../contexts/aiChatStore';
import { useComposerDraftBinding } from '../../hooks/useComposerDraftBinding';
import { useNextDelegate } from '../../hooks/useNextDelegate';
import { SHARED_UNSENT, createComposerDraftStore } from '../../services/composerDrafts';
import {
  delegateClient,
  setNextDelegate,
  type DelegateCli,
  type RunnerPreset,
} from '../../services/delegateClient';
import { currentVision } from '../../services/modelCapability';
import { gatewayStateSnapshot } from '../../services/nomiModel';
import { type ImageAttachment } from '../../services/screenClient';
import { useShortcutBindings } from '../../services/shortcuts';
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
import { findCommand, flattenGroups, searchCommands } from '../../slash/registry';
import type { ModelArgOption, SlashCommand } from '../../slash/types';
import { useAtPathOptions } from '../../slash/useAtPathOptions';
import { PermissionTip } from '../EndpointControls';
import { ErrorHint } from '../ErrorHint';
import { ComposerChangesPill } from '../SessionWorkspace/ComposerChangesPill';
import { VoiceSettingsModal, VoiceStatusRow, useChatVoice } from '../VoiceInput';

import { AttachRow } from './AttachRow';
import { ComposerBar } from './ComposerBar';
import { ComposerPalettes } from './ComposerPalettes';
import { ComposerReferenceLinks } from './ComposerReferenceLinks';
import {
  processImageFiles,
  processOtherFiles,
  addImagesToList,
  addFilesToList,
  processHostDroppedFiles,
} from './fileHandlers';
import { ImageLightbox } from './ImageLightbox';
import styles from './index.module.css';
import { createKeyDownHandler } from './keyboardHandlers';
import { createSendHandler } from './sendHandlers';
import { buildAllCommands, commandsToSlashCommands, buildCommandRegistry } from './slashCommands';
import type { MessageInputProps } from './types';
import { useAutoHeight } from './useAutoHeight';
import { useCompactComposerLayout } from './useCompactComposerLayout';
import { useComposing } from './useComposing';
import { useDragDrop } from './useDragDrop';
import { useKnowledgeMode } from './useKnowledgeMode';
import { useReferenceDraft } from './useReferenceDraft';
import { useUncontrolledValue } from './useUncontrolledValue';

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
  endpointTab,
  modelControl,
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
  const [agentIdx, setAgentIdx] = useState(0);
  /** `/model ` 补全：候选（null = 还在读）、高亮项、按 Esc 关掉时的输入 */
  const [modelOpts, setModelOpts] = useState<ModelArgOption[] | null>(null);
  const [modelIdx, setModelIdx] = useState(0);
  const [modelClosed, setModelClosed] = useState<string | null>(null);
  /** 按 Esc 关掉助手列表时的输入；输入一变就重新出现 */
  const [agentClosed, setAgentClosed] = useState<string | null>(null);
  /** `/agent ` 补全用的已安装 agent（委派设置里的检测结果）；null = 还没读到 */
  const [agentInstalled, setAgentInstalled] = useState<DelegateCli[] | null>(null);
  const [agentPresets, setAgentPresets] = useState<RunnerPreset[]>([]);
  /** @ 路径补全：光标、高亮项、Esc 关闭快照、已缓存的工作区树 */
  const [caret, setCaret] = useState(0);
  const [atIdx, setAtIdx] = useState(0);
  const [atClosed, setAtClosed] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const multiline = useCompactComposerLayout(textareaRef, message, compact && floating);

  // 组字状态（IME）：组字期间不写文本、不量高度；漏 compositionend 时能自愈。
  // 这两个 hook 必须排在下面的光标恢复 effect 之前：先写 DOM，再摆光标。
  const {
    composingRef,
    clearComposing,
    markComposing,
    onCompositionStart,
    onCompositionEnd,
    isCompositionEvent,
    isComposing,
  } = useComposing(textareaRef, (el) => {
    setMessage(el.value);
    setCaret(el.selectionStart ?? el.value.length);
  });

  // 输入框是非受控的：DOM 自己持有文本，React 只在外部改值且不在组字时写回。
  useUncontrolledValue(textareaRef, message, isComposing, clearComposing);
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
  // `/cli 名字`：下一个需求交给哪个 agent（输入栏上的 chip，点 × 取消）
  const nextDelegate = useNextDelegate();
  const { kbMode, kbAvailable, toggleKb } = useKnowledgeMode(textareaRef);

  // ───── 图片附件：粘贴 / 拖入（images/files 由 draft binding 持有）─────
  const [viewing, setViewing] = useState<ImageAttachment | null>(null);
  const closeViewer = useCallback(() => setViewing(null), []);
  const [imgErr, setImgErr] = useState('');
  const addImages = useCallback(
    (list: ImageAttachment[]) => {
      setImgErr('');
      setImages((cur) => addImagesToList(cur, list, setImgErr));
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    [setImages],
  );
  const addFiles = useCallback(
    async (files: File[]) => {
      const imgs = await processImageFiles(files, setImgErr);
      if (imgs.length) addImages(imgs);
      return imgs.length > 0;
    },
    [addImages],
  );
  const addOtherFiles = useCallback(
    async (list: File[]) => {
      const out = await processOtherFiles(list, setImgErr);
      if (!out.length) return;
      setFiles((cur) => addFilesToList(cur, out, setImgErr));
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    [setFiles],
  );
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
  const takeHostFiles = useCallback(
    async (list: Parameters<typeof processHostDroppedFiles>[0]) => {
      const { images: imgs, files: fileList } = await processHostDroppedFiles(list, setImgErr);
      if (imgs.length) void addFiles(imgs);
      if (fileList.length) {
        setFiles((cur) => addFilesToList(cur, fileList, setImgErr));
        requestAnimationFrame(() => textareaRef.current?.focus());
      }
    },
    [addFiles, setFiles],
  );
  const dragOver = useDragDrop(takeFiles, takeHostFiles);
  // 只有元数据明确说不支持看图才提示；没有元数据（undefined）不吓用户，也不按名字猜
  const visionKnown = currentVision();
  // agent 标签由调用方给出发图能力（当前 CLI 模型），不能拿 Nomi 自己的模型去判断
  const visionWarn =
    images.length > 0 &&
    (imageCapability !== undefined ? imageCapability === 'none' : visionKnown === false);

  const handleSend = createSendHandler(
    {
      actions,
      onSend,
      busyOverride,
      imageCapability,
      imageUnsupportedReason,
      kbMode,
      kbAvailable,
      busy: busyOverride ?? isLoading,
      queue,
      slash,
      getRegistry,
      clearActive,
      setImgErr,
      setImages,
      setFiles,
      setMessage,
    },
    linkedDraft,
    images,
    files,
  );

  const syncCaret = () => {
    const el = textareaRef.current;
    if (el != null) setCaret(el.selectionStart);
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    // 组字中途不把文本写进 React：一写就会覆盖半截的组字内容，高度测量也会把候选条带走。
    if (isCompositionEvent(e.nativeEvent as InputEvent)) {
      // 漏了 compositionstart 就在这里补标记，自动高度才不会在半路重排
      if (!composingRef.current) markComposing(e.target);
      return;
    }
    // 确认不是组字：标记还挂着（漏了 compositionend）就顺手清掉，输入框不会一直哑着。
    clearComposing(e.target);
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

  // 停止：Nomi 流式生成中，或 agent 标签自带的停止；输入为空才显示（有字时发送键是「排队」）
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

  const allCommands = buildAllCommands(
    {
      onAttach: () => fileInputRef.current?.click(),
      onProvidersClick,
      onDesktopClick,
      onHubClick,
      onExtClick,
      onLocalClick,
      onSettingsClick,
      onPluginsClick,
      toggleKb,
      insertAt,
    },
    {
      bindings,
      kbMode,
      kbAvailable,
      cwd,
      delegate,
      cvReady: cv.ready,
      cvAvailable: cv.v.available,
      onCvSettings: () => cv.setShowSettings(true),
    },
  );
  const commands = allCommands.filter((c) => c.show);
  const uiSlash = commandsToSlashCommands(commands);
  // 函数声明（提升）：handleSend 在渲染期就捕获了这个引用
  function getRegistry() {
    return buildCommandRegistry(uiSlash, slash);
  }
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
  const agentOptions =
    agentQuery === null
      ? []
      : filterAgents(agentInstalled, agentQuery, agentPresets, gatewayStateSnapshot());
  const agentOpen = agentQuery !== null && agentClosed !== message;
  /** 从助手列表选中：补成 `/agent <id> ` */
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
      .then((v) => {
        if (!live) return;
        setAgentInstalled(Array.isArray(v?.installed) ? v.installed : []);
        setAgentPresets(v?.enabled && Array.isArray(v?.presets) ? v.presets : []);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [agentPhase]);
  const modelQuery = slash ? modelArgQuery(message, registry) : null;
  const modelOptions = modelQuery === null ? [] : filterModelOptions(modelOpts, modelQuery);
  const modelOpen = modelQuery !== null && modelClosed !== message && !!slash?.modelOptions;
  /** 从模型列表选中：补成 `/model <value>` */
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

  const handleKeyDown = createKeyDownHandler({
    composingRef,
    agentOpen,
    agentOptions,
    agentIdx,
    agentQuery,
    setAgentIdx,
    setAgentClosed,
    pickAgent,
    modelOpen,
    modelOptions,
    modelIdx,
    modelQuery,
    setModelIdx,
    setModelClosed,
    pickModelArg,
    slashOpen,
    slashFlat,
    slashIdx,
    setSlashIdx,
    pickCommand,
    setMessage,
    atOpen,
    atOptions,
    atIdx,
    setAtIdx,
    setAtClosed,
    pickAtPath,
    message,
    busy,
    queue,
    handleSend,
    getChatMessages: () => chatStore.get().messages,
    newlineCaret,
  });

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
      {!compact && !modelControl && <PermissionTip tab={endpointTab} />}
      {viewing && images.some((x) => x.id === viewing.id) && (
        <ImageLightbox image={viewing} onClose={closeViewer} />
      )}
      {contextMessages?.length ? <ComposerChangesPill messages={contextMessages} /> : null}
      <div
        className={`${styles.inputWrapper} ${compact ? styles.compact : ''} ${floating ? styles.floating : ''} ${multiline ? styles.multiline : ''} ${dragOver ? styles.dragOver : ''}`}
        data-compact={compact || undefined}
      >
        <ComposerPalettes
          slashOpen={slashOpen}
          slashGroups={slashGroups}
          slashFlatLength={slashFlat.length}
          slashIdx={slashIdx}
          slashQuery={slashQuery}
          blockedSlash={blockedSlash}
          onPickCommand={(c) => pickCommand(c, 'run')}
          onHoverCommand={setSlashIdx}
          agentOpen={agentOpen}
          agentOptions={agentOptions}
          agentIdx={agentIdx}
          onPickAgent={pickAgent}
          onHoverAgent={setAgentIdx}
          modelOpen={modelOpen}
          modelOptions={modelOptions}
          modelLoading={modelOpts === null}
          modelIdx={modelIdx}
          onPickModel={pickModelArg}
          onHoverModel={setModelIdx}
          atOpen={atOpen}
          atOptions={atOptions}
          atIdx={atIdx}
          onPickAtPath={pickAtPath}
          onHoverAtPath={setAtIdx}
          argHint={argHint}
        />
        {(images.length > 0 || files.length > 0 || imgErr) && (
          <AttachRow
            images={images}
            files={files}
            imgErr={imgErr}
            visionWarn={visionWarn}
            imageCapability={imageCapability}
            imageUnsupportedReason={imageUnsupportedReason}
            onView={setViewing}
            onRemoveImage={(id) => setImages((c) => c.filter((x) => x.id !== id))}
            onRemoveFile={(id) => setFiles((c) => c.filter((x) => x.id !== id))}
          />
        )}
        <ComposerReferenceLinks draft={linkedDraft} />
        <textarea
          ref={textareaRef}
          // 非受控：见上方同步 effect。受控 value 在组字期间回写会吞掉刚打的字。
          defaultValue={message}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onSelect={syncCaret}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onCompositionStart={onCompositionStart}
          onCompositionEnd={onCompositionEnd}
          onBlur={(e) => clearComposing(e.currentTarget)}
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

        <ComposerBar
          commands={commands}
          menuOpen={menuOpen}
          onMenuOpenChange={setMenuOpen}
          fileInputRef={fileInputRef}
          onFiles={takeFiles}
          onDelegate={(target, meta) => {
            setNextDelegate(target, meta);
            requestAnimationFrame(() => textareaRef.current?.focus());
          }}
          kbMode={kbMode}
          kbAvailable={kbAvailable}
          toggleKb={toggleKb}
          nextDelegate={nextDelegate}
          onClearDelegate={() => setNextDelegate(null)}
          compact={compact}
          modelControl={modelControl}
          endpointTab={endpointTab}
          cv={cv}
          disabled={disabled}
          contextMessages={contextMessages}
          contextModel={contextModel}
          canStop={canStop}
          stopFn={stopFn}
          onSend={() => void handleSend()}
          sendDisabled={
            isDisabled || (!linkedDraft.serialized.trim() && !images.length && !files.length)
          }
          queueActive={!!queue && busy}
          busy={busy}
        />
      </div>
      <VoiceSettingsModal cv={cv} />
    </div>
  );
};

/** Memoized: App rerenders (tabs, panels) do not rerender the composer unless its props change. */
export const MessageInput = memo(MessageInputImpl);
