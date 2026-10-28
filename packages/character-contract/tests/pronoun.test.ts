import { describe, expect, it } from 'vitest';

import { personaPronoun, personaSchema, pronounForms } from '../src';

describe('persona pronoun', () => {
  it('defaults to the neutral 它 / it per language', () => {
    expect(personaPronoun('zh')).toBe('它');
    expect(personaPronoun('zh-CN', ' ')).toBe('它');
    expect(personaPronoun('en')).toBe('it');
    expect(personaPronoun('ja')).toBe('it');
    expect(personaPronoun('zh', '她')).toBe('她');
  });

  it('derives the English object and possessive forms', () => {
    expect(pronounForms('en', 'she')).toEqual({ object: 'her', possessive: 'her' });
    expect(pronounForms('en', 'He')).toEqual({ object: 'him', possessive: 'his' });
    expect(pronounForms('en', 'it')).toEqual({ object: 'it', possessive: 'its' });
    expect(pronounForms('en', 'they')).toEqual({ object: 'them', possessive: 'their' });
    expect(pronounForms('en', 'Pip')).toEqual({ object: 'Pip', possessive: 'Pip’s' });
    expect(pronounForms('zh-CN', '她')).toEqual({ object: '她', possessive: '她' });
  });

  it('is an optional non-empty persona field', () => {
    const base = { displayName: 'X', systemPromptIdentity: 'x', greetings: [] };
    expect(personaSchema.parse({ ...base, pronoun: '她' }).pronoun).toBe('她');
    expect(personaSchema.safeParse({ ...base, pronoun: '' }).success).toBe(false);
    expect(personaSchema.parse(base).pronoun).toBeUndefined();
  });
});
