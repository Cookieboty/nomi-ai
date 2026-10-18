import { describe, expect, it } from 'vitest';

import { argPhase, paletteQuery, parseSlashInput } from '../src/slash/parse';

describe('parseSlashInput', () => {
  it('普通文字不是命令', () => {
    expect(parseSlashInput('hello /context')).toEqual({ type: 'text' });
    expect(parseSlashInput(' /context')).toEqual({ type: 'text' });
    expect(parseSlashInput('')).toEqual({ type: 'text' });
  });
  it('解析命令名与参数（含多行）', () => {
    expect(parseSlashInput('/model  gpt-5  ')).toEqual({
      type: 'command',
      value: { name: 'model', args: 'gpt-5', raw: '/model  gpt-5' },
    });
    const r = parseSlashInput('/review 第一行\n第二行');
    expect(r.type === 'command' && r.value.args).toBe('第一行\n第二行');
  });
  it('命名空间 / 点 / 连字符', () => {
    const r = parseSlashInput('/frontend:component Button');
    expect(r.type === 'command' && r.value.name).toBe('frontend:component');
    const r2 = parseSlashInput('/my-skill.v2');
    expect(r2.type === 'command' && r2.value.name).toBe('my-skill.v2');
  });
  it('路径形态当普通文字', () => {
    expect(parseSlashInput('/usr/bin/ls 是什么')).toEqual({ type: 'text' });
    expect(parseSlashInput('/')).toEqual({ type: 'text' });
    expect(parseSlashInput('/ foo')).toEqual({ type: 'text' });
  });
  it('// 转义成字面文字', () => {
    expect(parseSlashInput('//context 是什么')).toEqual({
      type: 'escaped',
      text: '/context 是什么',
    });
  });
});

describe('paletteQuery / argPhase', () => {
  it('只在命令名阶段弹面板', () => {
    expect(paletteQuery('/')).toBe('');
    expect(paletteQuery('/con')).toBe('con');
    expect(paletteQuery('/con ')).toBeNull();
    expect(paletteQuery('hi /con')).toBeNull();
    expect(paletteQuery('//x')).toBeNull();
    expect(paletteQuery('/a/b')).toBeNull();
  });
  it('参数阶段', () => {
    expect(argPhase('/model gp')).toEqual({ name: 'model', args: 'gp' });
    expect(argPhase('/model ')).toEqual({ name: 'model', args: '' });
    expect(argPhase('/model')).toBeNull();
  });
});
