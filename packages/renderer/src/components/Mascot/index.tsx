import React, { Suspense, lazy, useEffect, useMemo, useState } from 'react';

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
import { characterBox } from '@/mascot/spriteLayout';

// three / VRM 体积较大：按需加载
const VirtualCharacter3D = lazy(() => import('../VirtualCharacter3D'));
function vrmBoxStyle(): React.CSSProperties {
  const b = characterBox(window.innerWidth, window.innerHeight);
  return { position: 'absolute', left: b.x, top: b.y, width: b.w, height: b.h };
}

// Rive is the default 2D mascot renderer (with the layered 2D rig as fallback if it cannot start).
// The scene embeds the locked Nomi art layers and is loaded lazily so VRM-only installations do
// not pay the startup cost.
const Nomi2DCanvas = lazy(() => import('./Nomi2DCanvas'));
const MascotAIBridge = lazy(() => import('@/mascot/MascotAIBridge'));
const MascotVoiceBridge = lazy(() => import('@/mascot/voice/MascotVoice'));

/**
 * 看板娘宿主：气泡 + 工具栏 + 角色画布（VRM 或 2D sprite）。
 * 必须位于 MascotProvider 内。
 */
export const MascotHost: React.FC = () => {
  const { currentModel } = useMascot();
  const aiReady = useMemo(() => isAiIpcReady(), []);
  useMascotTips();
  useMascotZoomInput();
  // 窗口被缩放（Ctrl/⌘+滚轮 / 菜单 / 设置滑块）：VRM 的角色框要跟着重算
  const [, setViewport] = useState(0);
  useEffect(() => {
    const on = () => setViewport((n) => n + 1);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
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
              {currentModel.path.includes('/sprite/') ||
              currentModel.path.endsWith('manifest.json') ||
              currentModel.tags?.includes('sprite') ? (
                // symmetric margins are built into the sprite layout (spriteLayout.ts)
                <Nomi2DCanvas manifestPath={currentModel.path} />
              ) : (
                // user / store VRM: same character box as Nomi (half size, room for bubble + toolbar)
                <div style={vrmBoxStyle()}>
                  <VirtualCharacter3D
                    modelPath={currentModel.path}
                    modelConfig={currentModel.config}
                    enableMCPIntegration
                    enableVoiceSync
                    enableControls={false}
                    transparent
                  />
                </div>
              )}
            </Suspense>
          </CanvasBoundary>
        )}
      </div>
    </div>
  );
};

export default MascotHost;
