/**
 * 看板娘（Rive 版）：原样用 avatar-runtime 的 AvatarStage 加载现有 characters/nomi 角色包（character.riv）。
 * 只在 mascot.renderer = rive 时由 mascot.ts 动态 import；卸载时 React 卸载 AvatarStage，
 * RiveCanvas 的清理函数调用 rive.cleanup() 释放 WebGL 上下文。
 */
import {
  AvatarStage,
  avatarCharacterFromPack,
  createAvatarEventHub,
} from '@nomi-ai/avatar-runtime';
import riveWasmUrl from '@rive-app/canvas-lite/rive.wasm?url';
import React from 'react';
import { createRoot } from 'react-dom/client';
import pack from 'virtual:character-pack';

export function mount(app: HTMLElement, mark: (n: string) => void): () => void {
  const events = createAvatarEventHub();
  const character = avatarCharacterFromPack(pack);
  const resolveAsset = (p: string): string => `${pack.base}${p}`;
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;inset:0;';
  app.appendChild(host);
  const root = createRoot(host);
  root.render(
    <AvatarStage
      character={character}
      resolveAsset={resolveAsset}
      events={events}
      riveWasmUrl={riveWasmUrl}
      onInteraction={() => {}}
      onMark={mark}
    />,
  );
  const greet = setTimeout(() => events.emit({ type: 'cue', cue: { kind: 'greeting' } }), 1500);
  return () => {
    clearTimeout(greet);
    root.unmount();
    host.remove();
  };
}
