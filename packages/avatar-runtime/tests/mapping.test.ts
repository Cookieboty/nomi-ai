/**
 * 语义 → 资源的映射（docs/design/core-host-decoupling.md §10.5）：
 *
 * - 官方包 characters/nomi/mapping.json 与引擎默认映射相同，并覆盖 AI 能发出的全部语义名；
 * - C3 之前 AI 工具、内核服务、托盘与表情导演直接给出的动作 / 表情名，换成语义名后经映射在
 *   Rive 与分层 2D 两个后端上落到同一个动作（行为不变）；
 * - 不在词表里、或当前包没有映射的名字忽略。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  mappingSchema,
  SEMANTIC_ACTIVITIES,
  SEMANTIC_EMOTIONS,
  SEMANTIC_GESTURES,
  type PackMapping,
} from '@nomi-ai/character-contract';
import { repoPath } from '@nomi-ai/repo-paths';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RIVE_MOTION_ALIASES, RIVE_NATIVE_MOTIONS } from '../src/backends/rive';
import { resolveRigMotion } from '../src/backends/sprite';
import { applyActivity, applyEmotion } from '../src/driver';
import {
  activityTarget,
  currentAvatarMapping,
  DEFAULT_AVATAR_MAPPING,
  emotionTarget,
  gestureTarget,
  mappedSemantics,
  setAvatarMapping,
} from '../src/mapping';
import { MASCOT_EXPRESSIONS, mascotRegistry, type MascotBackend } from '../src/MascotBackend';
import { playGesture, resetMoodForTests } from '../src/mood';

const CHARACTERS = repoPath('characters');

function packMapping(id: string): PackMapping {
  const raw: unknown = JSON.parse(readFileSync(path.join(CHARACTERS, id, 'mapping.json'), 'utf8'));
  return mappingSchema.parse(raw);
}

const NOMI = packMapping('nomi');

/** C3 之前到达后端的动作名 → 现在发的语义手势 */
const LEGACY_GESTURES: Record<string, string> = {
  // AI 工具 avatar_gesture 的说明里列出的动作名（全部）
  wave: 'wave',
  hello: 'greet',
  nod: 'nod',
  shake_head: 'shakeHead',
  bow: 'bow',
  salute: 'salute',
  think: 'think',
  explain: 'explain',
  eureka: 'eureka',
  puzzled: 'puzzled',
  listen: 'listen',
  look_around: 'lookAround',
  look_lr: 'lookLeftRight',
  peek: 'peek',
  heart: 'heart',
  blow_kiss: 'blowKiss',
  shy: 'shy',
  cover_face: 'coverFace',
  sorry: 'apologize',
  surprise: 'surprise',
  sigh: 'sigh',
  smug: 'smug',
  aggrieved: 'aggrieved',
  tears: 'tears',
  angry: 'angry',
  cold_sweat: 'coldSweat',
  daze: 'daze',
  cheer: 'cheer',
  thumbs_up: 'thumbsUp',
  peace: 'peace',
  celebrate: 'celebrate',
  clap: 'clap',
  hop: 'hop',
  wink: 'wink',
  tongue: 'tongue',
  cute: 'cute',
  work: 'work',
  yawn: 'yawn',
  stretch: 'stretch',
  goodnight: 'goodnight',
  peek_note: 'hum',
  // 内核服务 / 托盘 / 表情导演用过的其余名字
  shake: 'shakeHead',
  flinch: 'startle',
  interact: 'reachOut',
  // 骨架里有、AI 以前也能直接点名的
  pray: 'pray',
  ok_hand: 'okHand',
};

/** 名字在两个后端上落到的动作（Rive 原生片段 / 2D 骨架关键帧 id；没有为 null） */
function landsOn(name: string) {
  const rive = RIVE_MOTION_ALIASES[name] ?? name;
  return {
    rive: (RIVE_NATIVE_MOTIONS as readonly string[]).includes(rive) ? rive : null,
    sprite: resolveRigMotion(name),
  };
}

afterEach(() => {
  setAvatarMapping(null);
  resetMoodForTests();
});

describe('official pack mapping (characters/nomi/mapping.json)', () => {
  it('equals the engine default mapping (packs without mapping.json behave like Nomi)', () => {
    expect(NOMI).toEqual(DEFAULT_AVATAR_MAPPING);
  });

  it('maps every semantic gesture and every non-idle activity the AI can emit', () => {
    for (const g of SEMANTIC_GESTURES) expect(NOMI.gestures?.[g], g).toBeTruthy();
    for (const a of SEMANTIC_ACTIVITIES.filter((x) => x !== 'idle'))
      expect(NOMI.activities?.[a], a).toBeTruthy();
  });

  it('maps every emotion that had an expression before C3; the rest are ignored', () => {
    for (const e of MASCOT_EXPRESSIONS) expect(NOMI.emotions?.[e], e).toBe(e);
    const unmapped = SEMANTIC_EMOTIONS.filter((e) => !NOMI.emotions?.[e]);
    // 没有对应表情的语义情绪：以前 avatar_emotion 直接拒绝，现在经映射忽略，行为相同
    expect(unmapped).toEqual(['shy', 'confused', 'sleepy']);
  });

  it.each(Object.entries(LEGACY_GESTURES))(
    'legacy motion %s → gesture %s lands on the same clip on both backends',
    (legacy, semantic) => {
      setAvatarMapping(NOMI);
      const target = gestureTarget(semantic);
      expect(target).not.toBeNull();
      expect(landsOn(target!)).toEqual(landsOn(legacy));
    },
  );

  it('activities land on the hold poses used before (thinking → think, toolRunning → work)', () => {
    setAvatarMapping(NOMI);
    expect(activityTarget('thinking')).toBe('think');
    expect(activityTarget('toolRunning')).toBe('work');
    expect(activityTarget('idle')).toBeNull();
  });

  it('reports the semantic names it can show', () => {
    const scene = mappedSemantics(NOMI);
    expect(scene.gestures).toEqual([...SEMANTIC_GESTURES]);
    expect(scene.activities).toEqual([...SEMANTIC_ACTIVITIES]);
    expect(scene.emotions).toEqual(['neutral', 'happy', 'sad', 'angry', 'surprised', 'relaxed']);
  });
});

describe('test-dummy pack mapping (static, no motions)', () => {
  it('maps only neutral; everything else is ignored', () => {
    const dummy = packMapping('test-dummy');
    setAvatarMapping(dummy);
    expect(emotionTarget('neutral')).toBe('neutral');
    expect(emotionTarget('happy')).toBeNull();
    expect(gestureTarget('wave')).toBeNull();
    expect(activityTarget('thinking')).toBeNull();
    expect(mappedSemantics(dummy)).toEqual({
      emotions: ['neutral'],
      activities: ['idle'],
      gestures: [],
    });
  });
});

describe('2.0.5-template mapping.json (emotions point at motions)', () => {
  // 2.0.5 的 characters/nomi/mapping.json：运行时不读它，照着它写的覆盖包靠引擎默认行为
  const TEMPLATE_2_0_5 = {
    emotions: { happy: 'nod', sad: 'tears', angry: 'angry', surprised: 'surprise', shy: 'shy' },
    activities: { thinking: 'think', toolRunning: ['work', 'typing'] },
    gestures: { wave: 'wave', nod: 'nod', apologize: ['apology', 'sorry'] },
  };

  it('falls back to the engine default mapping, so expressions and all gestures still play', () => {
    setAvatarMapping(TEMPLATE_2_0_5);
    expect(emotionTarget('happy')).toBe('happy');
    expect(emotionTarget('sad')).toBe('sad');
    expect(gestureTarget('startle')).toBe('flinch');
    expect(gestureTarget('thumbsUp')).toBe('thumbs_up');
    expect(gestureTarget('goodnight')).toBe('goodnight');
    expect(mappedSemantics(currentAvatarMapping())).toEqual(
      mappedSemantics(DEFAULT_AVATAR_MAPPING),
    );
  });
});

describe('unknown and unmapped semantic names are ignored', () => {
  function spy() {
    const b = {
      kind: 'sprite',
      setExpression: vi.fn(),
      playMotion: vi.fn(() => true),
    } as unknown as MascotBackend & {
      setExpression: ReturnType<typeof vi.fn>;
      playMotion: ReturnType<typeof vi.fn>;
    };
    return { b, detach: mascotRegistry.attach(b) };
  }

  it('names outside the vocabulary never reach the backend, even if the pack maps them', () => {
    setAvatarMapping({ gestures: { backflip: 'backflip' }, emotions: { ecstatic: 'happy' } });
    const { b, detach } = spy();
    expect(playGesture('backflip')).toBe(false);
    expect(playGesture('thumbs_up')).toBe(false); // 资源名不是语义名
    expect(applyEmotion('ecstatic')).toBe(false);
    expect(applyActivity('sleeping')).toBe(false);
    expect(b.playMotion).not.toHaveBeenCalled();
    expect(b.setExpression).not.toHaveBeenCalled();
    detach();
  });

  it('vocabulary names the pack does not map are skipped', () => {
    setAvatarMapping({ gestures: { wave: 'hand_wave_02' }, emotions: { happy: 'smile_02' } });
    const { b, detach } = spy();
    expect(playGesture('nod')).toBe(false);
    expect(playGesture('wave')).toBe(true);
    expect(b.playMotion).toHaveBeenCalledWith('hand_wave_02');
    applyEmotion('sad', 0.5);
    expect(b.setExpression).not.toHaveBeenCalled();
    applyEmotion('happy', 0.5);
    expect(b.setExpression).toHaveBeenCalledWith('smile_02', 0.5);
    expect(applyActivity('thinking')).toBe(true); // 执行了，但没有映射：不播动作
    expect(b.playMotion).toHaveBeenCalledTimes(1);
    detach();
  });

  it('a list of targets picks one of them', () => {
    setAvatarMapping({ gestures: { cheer: ['fist', 'fist_pump'] } });
    expect(gestureTarget('cheer', () => 0)).toBe('fist');
    expect(gestureTarget('cheer', () => 0.99)).toBe('fist_pump');
  });

  it('no mapping.json → the engine default mapping', () => {
    setAvatarMapping(undefined);
    expect(gestureTarget('thumbsUp')).toBe('thumbs_up');
    expect(emotionTarget('relaxed')).toBe('relaxed');
  });
});
