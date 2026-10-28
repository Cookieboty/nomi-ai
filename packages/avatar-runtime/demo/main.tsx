/**
 * avatar-runtime 独立开发页：一个假的语义事件源（按钮 / 口型正弦波）+ 互动输出日志。
 * 没有窗口宿主，所以拖拽与点击穿透不发生；点击、摸头等互动照常反应并记入日志。
 */
import riveWasmUrl from '@rive-app/canvas-lite/rive.wasm?url';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import pack from 'virtual:character-pack';

import {
  ACTIONS,
  AvatarStage,
  avatarCharacterFromPack,
  createAvatarEventHub,
  MASCOT_EXPRESSIONS,
  mascotRegistry,
  type AvatarEvent,
  type AvatarInteractionEvent,
  type MascotEvent,
} from '../src';

const events = createAvatarEventHub();
const character = avatarCharacterFromPack(pack);
const resolveAsset = (p: string): string => `${pack.base}${p}`;

const CUES: MascotEvent[] = [
  { kind: 'greeting' },
  { kind: 'agent:step' },
  { kind: 'tool:running' },
  { kind: 'tool:executed', ok: true },
  { kind: 'tool:executed', ok: false },
  { kind: 'task:done', all: true },
  { kind: 'task:failed' },
  { kind: 'confirm-required' },
  { kind: 'file:drop' },
  { kind: 'barge-in' },
];

const panel: React.CSSProperties = {
  flex: 1,
  overflow: 'auto',
  padding: 16,
  borderLeft: '1px solid #ccd',
  background: '#fff',
};
const row: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  margin: '6px 0 14px',
};

function useBackendMotions(): string[] {
  const [motions, setMotions] = useState<string[]>([]);
  useEffect(() => mascotRegistry.subscribe((b) => setMotions(b?.capabilities().motions ?? [])), []);
  return motions;
}

const Demo: React.FC = () => {
  const [log, setLog] = useState<string[]>([]);
  const [talking, setTalking] = useState(false);
  const [reply, setReply] = useState('太好了！！任务完成啦 🎉');
  const motions = useBackendMotions();
  const gestures = useMemo(
    () => (motions.length ? motions : ACTIONS.map((a) => a.id)).slice(0, 24),
    [motions],
  );

  const push = useCallback((line: string) => setLog((l) => [line, ...l].slice(0, 50)), []);
  const emit = useCallback(
    (e: AvatarEvent) => {
      events.emit(e);
      if (e.type !== 'speaking') push(`→ ${JSON.stringify(e)}`);
    },
    [push],
  );
  const onInteraction = useCallback(
    (e: AvatarInteractionEvent) => push(`← ${JSON.stringify(e)}`),
    [push],
  );

  // 口型：说话时用正弦包络模拟 TTS 音量
  useEffect(() => {
    if (!talking) {
      events.emit({ type: 'speaking', level: 0 });
      return undefined;
    }
    const t0 = performance.now();
    const id = window.setInterval(() => {
      const t = (performance.now() - t0) / 1000;
      events.emit({ type: 'speaking', level: Math.abs(Math.sin(t * 9)) * 0.6 });
    }, 33);
    return () => window.clearInterval(id);
  }, [talking]);

  return (
    <>
      <div style={{ width: 420, height: 450, position: 'relative', flex: 'none' }}>
        <AvatarStage
          character={character}
          resolveAsset={resolveAsset}
          events={events}
          onInteraction={onInteraction}
          riveWasmUrl={riveWasmUrl}
          onMark={(name) => push(`mark ${name}`)}
          debugHandles
        />
      </div>
      <div style={panel}>
        <h3 style={{ margin: '0 0 8px' }}>
          {character.id} · {character.mode}
        </h3>
        <div>Emotion</div>
        <div style={row}>
          {MASCOT_EXPRESSIONS.map((name) => (
            <button key={name} onClick={() => emit({ type: 'emotion', name })}>
              {name}
            </button>
          ))}
        </div>
        <div>Gesture{motions.length ? '' : ' (this backend plays none)'}</div>
        <div style={row}>
          {gestures.map((name) => (
            <button key={name} onClick={() => emit({ type: 'gesture', name })}>
              {name}
            </button>
          ))}
        </div>
        <div>Cue</div>
        <div style={row}>
          {CUES.map((cue) => (
            <button key={JSON.stringify(cue)} onClick={() => emit({ type: 'cue', cue })}>
              {JSON.stringify(cue).replace(/[{}"]/g, '')}
            </button>
          ))}
        </div>
        <div>Reply / speaking</div>
        <div style={row}>
          <input value={reply} onChange={(e) => setReply(e.target.value)} style={{ flex: 1 }} />
          <button onClick={() => emit({ type: 'reply', phase: 'delta', text: reply })}>
            delta
          </button>
          <button onClick={() => emit({ type: 'reply', phase: 'complete', text: reply })}>
            complete
          </button>
          <button onClick={() => setTalking((v) => !v)}>{talking ? 'stop' : 'talk'}</button>
        </div>
        <div>Log (→ events in, ← interactions out)</div>
        <pre data-testid="log" style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>
          {log.join('\n')}
        </pre>
      </div>
    </>
  );
};

createRoot(document.getElementById('app')!).render(<Demo />);
