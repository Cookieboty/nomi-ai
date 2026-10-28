import { t } from '@nomi-ai/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mascotReducer, type MascotState } from '../../src/contexts/MascotContext';
import { parseCatalog, pickModel, type MascotModel } from '../../src/mascot/catalog';
import { directiveForEvent, expressionForText } from '../../src/mascot/expressionDirector';
import { mascotRegistry, type MascotBackend } from '../../src/mascot/MascotBackend';
import { applyDirective } from '../../src/mascot/mood';
import { greetingFor, MOUSEOVER_TIPS } from '../../src/mascot/tips';

const model = (name: string): MascotModel => ({
  name,
  displayName: name,
  path: `./${name}.vrm`,
  author: 'a',
  license: 'CC0-1.0',
  source: 'https://example.com',
});

describe('catalog', () => {
  it('drops entries without a licence', () => {
    const out = parseCatalog({
      models: [model('a'), { name: 'b', path: './b.vrm' }, { ...model('c'), license: '' }],
    });
    expect(out.map((m) => m.name)).toEqual(['a']);
    expect(parseCatalog(null)).toEqual([]);
  });

  it('picks the named model or falls back to the first (Nomi)', () => {
    const list = [model('a'), model('b')];
    expect(pickModel(list, 'b')?.name).toBe('b');
    expect(pickModel(list, 'gone')?.name).toBe('a');
    expect(pickModel(list, null)?.name).toBe('a');
  });

  it('bundles only Nomi (no VRM or other sprites)', async () => {
    const fs = await import('node:fs');
    const raw = JSON.parse(
      fs.readFileSync(
        new URL('../../public/assets/models/model-list.json', import.meta.url),
        'utf8',
      ),
    );
    const list = parseCatalog(raw);
    expect(list.map((m) => m.name)).toEqual(['nomi']);
    expect(list[0].license).toBe('MIT'); // owner-provided, AI-generated
    expect(list.some((m) => m.path.endsWith('.vrm'))).toBe(false);
  });
});

describe('expressionDirector', () => {
  it('maps text to emotions', () => {
    expect(expressionForText('抱歉，我做不到')).toBe('sad');
    expect(expressionForText('哼！讨厌')).toBe('angry');
    expect(expressionForText('太好了，完成啦')).toBe('happy');
    expect(expressionForText('')).toBe('neutral');
    expect(expressionForText('今天天气不错')).toBe('happy');
  });

  it('maps events to directives', () => {
    expect(directiveForEvent({ kind: 'agent:step' })?.expression).toBe('relaxed');
    expect(directiveForEvent({ kind: 'tool:executed', ok: false })?.expression).toBe('sad');
    expect(directiveForEvent({ kind: 'tool:executed', ok: true })?.expression).toBe('happy');
    expect(directiveForEvent({ kind: 'message:complete', text: 'sorry' })?.expression).toBe('sad');
    expect(directiveForEvent({ kind: 'tts:end' })).toBeNull();
  });
});

describe('mascotRegistry + applyDirective', () => {
  afterEach(() => vi.useRealTimers());

  it('applies then reverts expressions on the attached backend', () => {
    vi.useFakeTimers();
    const setExpression = vi.fn();
    const backend = { kind: 'sprite', setExpression } as unknown as MascotBackend;
    const detach = mascotRegistry.attach(backend);
    applyDirective({ expression: 'happy', holdMs: 1000 });
    expect(setExpression).toHaveBeenLastCalledWith('happy');
    vi.advanceTimersByTime(1000);
    expect(setExpression).toHaveBeenLastCalledWith('neutral');
    detach();
    expect(mascotRegistry.current()).toBeNull();
  });
});

describe('MascotContext reducer', () => {
  const base: MascotState = {
    currentMessage: null,
    messagePriority: 0,
    dragEnabled: false,
    modelList: [],
    modelName: 'b',
    panel: null,
  };

  it('keeps a valid saved model and respects message priority', () => {
    let s = mascotReducer(base, { type: 'SET_MODEL_LIST', payload: [model('a'), model('b')] });
    expect(s.modelName).toBe('b');
    s = mascotReducer(s, { type: 'SET_MESSAGE', payload: { text: 'hi', priority: 9 } });
    s = mascotReducer(s, { type: 'SET_MESSAGE', payload: { text: 'low', priority: 1 } });
    expect(s.currentMessage).toBe('hi');
    s = mascotReducer(
      { ...base, modelName: 'gone' },
      { type: 'SET_MODEL_LIST', payload: [model('a')] },
    );
    expect(s.modelName).toBe('a');
  });
});

describe('misc', () => {
  it('has greetings and mouseover tips', () => {
    expect(t(greetingFor(8))).toMatch(/早上好/);
    expect(MOUSEOVER_TIPS.length).toBeGreaterThan(0);
  });
});
