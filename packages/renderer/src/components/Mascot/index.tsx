import React, { Suspense, lazy, useMemo } from 'react';

import { MessageBubble } from '../MessageBubble/MessageBubble';
import { ToolBar } from '../ToolBar';

import { CanvasBoundary } from './CanvasBoundary';
import { Credits } from './Credits';
import { DesktopConfirm } from './DesktopConfirm';
import { InteractionSettings } from './InteractionSettings';
import { MascotAiCueBridge, MascotAudioBridge } from './MascotAudioBridge';
import { MascotContextMenu } from './MascotContextMenu';
import { MotionMenu } from './MotionMenu';
import { ReminderCard } from './ReminderCard';
import styles from './style.module.css';

import { isAiIpcReady } from '@/ai/env';
import WaifuAgentBubbleBridge from '@/ai/WaifuAgentBubbleBridge';
import WaifuMascotSceneReporter from '@/ai/WaifuMascotSceneReporter';
import { useMascot } from '@/contexts/MascotContext';
import { useFileDropSummarize } from '@/hooks/useFileDropSummarize';
import { useMascotTips } from '@/hooks/useMascotTips';
import MascotDriver from '@/mascot/MascotDriver';
import { useMascotZoomInput } from '@/mascot/scaleStore';

// Rive is the default 2D mascot renderer (with the layered 2D rig as fallback if it cannot start).
// The scene embeds the locked Nomi art layers and is loaded lazily to keep the first paint light.
const Nomi2DCanvas = lazy(() => import('./Nomi2DCanvas'));
const MascotAIBridge = lazy(() => import('@/mascot/MascotAIBridge'));
const MascotVoiceBridge = lazy(() => import('@/mascot/voice/MascotVoice'));

/**
 * 看板娘宿主：气泡 + 工具栏 + Nomi 画布（Rive，失败时回退分层 2D）。
 * 必须位于 MascotProvider 内。
 */
export const MascotHost: React.FC = () => {
  const { currentModel } = useMascot();
  const aiReady = useMemo(() => isAiIpcReady(), []);
  useMascotTips();
  useMascotZoomInput();
  useFileDropSummarize('mascot-canvas');

  return (
    <div className={styles.root}>
      {aiReady && <WaifuAgentBubbleBridge />}
      {aiReady && (
        <Suspense fallback={null}>
          <MascotAIBridge />
          <MascotVoiceBridge />
        </Suspense>
      )}
      <MascotDriver />
      <MascotAudioBridge />
      {aiReady && (
        <Suspense fallback={null}>
          <MascotAiCueBridge />
        </Suspense>
      )}
      <WaifuMascotSceneReporter />
      <MessageBubble />
      <ToolBar />
      <MotionMenu />
      <Credits />
      <InteractionSettings />
      <MascotContextMenu />
      <DesktopConfirm />
      <ReminderCard />
      <div id="mascot-canvas" className={styles.stage} data-testid="mascot-canvas">
        {currentModel && (
          <CanvasBoundary resetKey={currentModel.path}>
            <Suspense fallback={null}>
              {/* symmetric margins are built into the sprite layout (spriteLayout.ts) */}
              <Nomi2DCanvas manifestPath={currentModel.path} />
            </Suspense>
          </CanvasBoundary>
        )}
      </div>
    </div>
  );
};

export default MascotHost;
