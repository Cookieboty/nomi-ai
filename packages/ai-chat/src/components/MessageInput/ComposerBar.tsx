import { t as tr, Icon } from '@nomi-ai/ui';
import {
  IconArrowUp as ArrowUp,
  IconBook2 as BookOpen,
  IconPlaylistAdd as ListPlus,
  IconSquare as Square,
  IconX as X,
} from '@tabler/icons-react';
import React from 'react';

import {
  getNextDelegateMeta,
  isPresetPin,
  type NextDelegateMeta,
  type NextDelegatePin,
} from '../../services/delegateClient';
import type { HarnessTabMeta } from '../../services/harnessClient';
import type { ConvMessage } from '../../types/conversation';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { EndpointControls } from '../EndpointControls';
import { ContextUsageBar } from '../SessionWorkspace/ContextUsageBar';
import { VoiceButtons, type ChatVoice } from '../VoiceInput';

import styles from './index.module.css';
import { PlusMenu } from './PlusMenu';
import type { SlashCommandItem } from './slashCommands';

interface ComposerBarProps {
  commands: SlashCommandItem[];
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFiles: (files: File[]) => boolean;
  onDelegate: (target: NextDelegatePin | null, meta?: NextDelegateMeta) => void;
  kbMode: boolean;
  kbAvailable: boolean;
  toggleKb: () => void;
  nextDelegate: NextDelegatePin | null;
  onClearDelegate: () => void;
  compact: boolean;
  modelControl?: React.ReactNode;
  endpointTab?: HarnessTabMeta | null;
  cv: ChatVoice;
  disabled: boolean;
  contextMessages?: readonly ConvMessage[];
  contextModel?: string | null;
  canStop: boolean;
  stopFn?: () => void;
  onSend: () => void;
  sendDisabled: boolean;
  queueActive: boolean;
  busy: boolean;
}

/** 输入框底部工具行：左边 ＋ / 知识库 / 委派 chip / 权限模式，右边模型、语音、上下文环、发送 / 停止 */
export const ComposerBar: React.FC<ComposerBarProps> = ({
  commands,
  menuOpen,
  onMenuOpenChange,
  fileInputRef,
  onFiles,
  onDelegate,
  kbMode,
  kbAvailable,
  toggleKb,
  nextDelegate,
  onClearDelegate,
  compact,
  modelControl,
  endpointTab,
  cv,
  disabled,
  contextMessages,
  contextModel,
  canStop,
  stopFn,
  onSend,
  sendDisabled,
  queueActive,
  busy,
}) => (
  <div className={styles.composerBar} data-testid="composer-bar">
    <div className={styles.composerLeft} data-zone="left">
      <PlusMenu
        open={menuOpen}
        onOpenChange={onMenuOpenChange}
        items={commands.filter((c) => c.menu)}
        fileInputRef={fileInputRef}
        onFiles={onFiles}
        onDelegate={onDelegate}
      />
      {kbMode && kbAvailable && (
        <button type="button" className={styles.chip} onClick={toggleKb} data-testid="kb-mode-chip">
          <Icon icon={BookOpen} size={14} />
          {tr('ui.foundation.knowledge-base')}
        </button>
      )}
      {nextDelegate &&
        (() => {
          const delegateLabel = isPresetPin(nextDelegate)
            ? (getNextDelegateMeta(nextDelegate)?.label ?? nextDelegate.slice('preset:'.length))
            : tr(ENDPOINT_NAME[nextDelegate]);
          return (
            <button
              type="button"
              className={styles.chip}
              onClick={onClearDelegate}
              aria-label={tr('ui.session-workspace.cancel-next-request-goes-to', delegateLabel)}
              data-testid="next-delegate-chip"
            >
              {tr('ui.session-workspace.to', delegateLabel)}
              <Icon icon={X} size={12} />
            </button>
          );
        })()}
      {/* Codex 式：左边是 + 与权限模式，模型放到右边、挨着语音与发送 */}
      {!compact && !modelControl && (
        <div className={styles.modelStatus}>
          <EndpointControls part="mode" tab={endpointTab} />
        </div>
      )}
    </div>
    <div className={styles.composerRight} data-zone="right">
      <div className={styles.modelStatus} data-testid="composer-model">
        {modelControl ?? <EndpointControls part="model" tab={endpointTab} />}
      </div>
      {compact && !modelControl && <EndpointControls part="mode" tab={endpointTab} />}
      {!compact && <VoiceButtons cv={cv} disabled={disabled} />}
      {!compact && contextMessages?.length ? (
        <ContextUsageBar messages={contextMessages} model={contextModel} />
      ) : null}
      {canStop ? (
        <button
          type="button"
          onClick={stopFn}
          className={styles.sendButton}
          aria-label={tr('ui.usage-tools.stop-generating')}
          data-testid="stop-button"
        >
          <Icon icon={Square} />
        </button>
      ) : (
        <button
          onClick={onSend}
          disabled={sendDisabled}
          className={styles.sendButton}
          aria-label={queueActive ? tr('ui.usage-tools.queue') : tr('ui.knowledge-local.send')}
          data-testid={queueActive ? 'queue-button' : 'send-button'}
        >
          {queueActive ? (
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
);
