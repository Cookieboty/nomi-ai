/** 看板娘窗口：原样用 avatar-runtime 的 AvatarStage 加载现有 characters/nomi 角色包（character.riv）。 */
import {
  AvatarStage,
  avatarCharacterFromPack,
  createAvatarEventHub,
} from '@nomi-ai/avatar-runtime';
import riveWasmUrl from '@rive-app/canvas-lite/rive.wasm?url';
import React from 'react';
import { createRoot } from 'react-dom/client';
import pack from 'virtual:character-pack';

const events = createAvatarEventHub();
const character = avatarCharacterFromPack(pack);
const resolveAsset = (p: string): string => `${pack.base}${p}`;
const st = document.getElementById('st')!;
const marks: string[] = [];

createRoot(document.getElementById('app')!).render(
  <AvatarStage
    character={character}
    resolveAsset={resolveAsset}
    events={events}
    riveWasmUrl={riveWasmUrl}
    onInteraction={() => {}}
    onMark={(name) => {
      marks.push(name);
      (window as unknown as { __marks: string[] }).__marks = marks;
      document.title = 'Nomi marks: ' + marks.join(',');
      // 测量模式：把渲染里程碑报给 Go 控制口（日志里可见），用来确认走的是 Rive 后端
      const ctl = new URLSearchParams(location.hash.slice(1)).get('ctl');
      if (ctl)
        void fetch(`http://${ctl}/mark?n=${encodeURIComponent(name)}`, { mode: 'no-cors' }).catch(
          () => {},
        );
    }}
  />,
);
window.addEventListener('error', (e) => (st.textContent = String(e.message)));
setTimeout(() => events.emit({ type: 'cue', cue: { kind: 'greeting' } }), 1500);
