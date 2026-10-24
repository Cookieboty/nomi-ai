import {
  buildDelegatePrompt,
  childPermissionMode,
  parseDelegateReport,
  parsePorcelain,
  pickDelegateCli,
  resolveDelegateCli,
  sanitizeDelegateSettings,
  tailText,
} from '../../../src/cli/delegate/core';

// Nomi 委派编程助手的纯逻辑（docs/design/nomi-delegate-cli.md）
describe('delegate core', () => {
  it('名字与别名不区分大小写；认不出返回 null', () => {
    expect(resolveDelegateCli('Codex')).toBe('codex');
    expect(resolveDelegateCli('claude code')).toBe('claude');
    expect(resolveDelegateCli('CC')).toBe('claude');
    expect(resolveDelegateCli('cursor')).toBeNull();
    expect(resolveDelegateCli(undefined)).toBeNull();
  });

  it('选谁：钉住 > 点名 > 任务类型默认 > 编程开发默认 > 已安装的第一个', () => {
    const installed = ['claude', 'codex', 'gemini'] as const;
    const base = { kind: 'prd' as const, defaults: {}, installed };
    expect(pickDelegateCli({ ...base, pinned: 'codex', requested: 'gemini' })).toEqual({
      cli: 'codex',
      by: 'pinned',
    });
    expect(pickDelegateCli({ ...base, requested: 'gemini' })?.by).toBe('requested');
    expect(pickDelegateCli({ ...base, defaults: { prd: 'gemini', coding: 'codex' } })?.cli).toBe(
      'gemini',
    );
    expect(pickDelegateCli({ ...base, defaults: { coding: 'codex' } })).toEqual({
      cli: 'codex',
      by: 'coding-default',
    });
    expect(pickDelegateCli(base)).toEqual({ cli: 'claude', by: 'auto' });
    // 点名 / 默认的没安装：往下找；钉住的没安装：直接失败（用户明确指定的不能悄悄换人）
    expect(pickDelegateCli({ ...base, requested: 'grok', defaults: { prd: 'dsh' } })?.by).toBe(
      'auto',
    );
    expect(pickDelegateCli({ ...base, pinned: 'grok' })).toBeNull();
    expect(pickDelegateCli({ ...base, installed: [] })).toBeNull();
  });

  it('子任务档位取 Nomi 档位与新标签默认档中更严的，永远不是完全放开', () => {
    expect(childPermissionMode('manual', 'acceptEdits')).toBe('manual');
    expect(childPermissionMode('auto', 'acceptEdits')).toBe('acceptEdits');
    expect(childPermissionMode('acceptEdits', 'plan')).toBe('plan');
    expect(childPermissionMode('auto', 'bypass')).toBe('auto');
  });

  it('任务说明：目标 / 背景 / 完成标准 / 不要碰，末尾要求固定格式汇报', () => {
    const p = buildDelegatePrompt({
      goal: '修复登录 bug',
      doneWhen: 'npm test 通过',
      outOfScope: '支付模块',
    });
    expect(p).toContain('目标：修复登录 bug');
    expect(p).toContain('完成标准：npm test 通过');
    expect(p).toContain('不要碰：支付模块');
    expect(p).not.toContain('背景：');
    expect(p.trimEnd().endsWith('</nomi-report>')).toBe(true);
  });

  it('解析最后一个 <nomi-report>：多行字段、「无」视为空、文件去掉列表符号', () => {
    const text = [
      '先看了一下代码。',
      '<nomi-report>',
      '做了什么：旧的',
      '</nomi-report>',
      '<nomi-report>',
      '做了什么：修好了登录',
      '补了测试',
      '改动的文件：',
      '- src/login.ts',
      '`tests/login.test.ts`',
      '没做完的：无',
      '需要用户决定的：要不要删旧接口',
      '</nomi-report>',
    ].join('\n');
    expect(parseDelegateReport(text)).toEqual({
      done: '修好了登录\n补了测试',
      changedFiles: ['src/login.ts', 'tests/login.test.ts'],
      needsUser: '要不要删旧接口',
    });
    expect(parseDelegateReport('没有汇报')).toBeNull();
    expect(parseDelegateReport('<nomi-report>\n改动的文件：a.ts\n</nomi-report>')).toBeNull();
  });

  it('git status --porcelain：取路径，重命名取新路径', () => {
    expect(parsePorcelain(' M src/a.ts\n?? b.ts\nR  old.ts -> new.ts\n')).toEqual([
      'src/a.ts',
      'b.ts',
      'new.ts',
    ]);
  });

  it('设置：未知值丢弃，开关默认开', () => {
    expect(sanitizeDelegateSettings(null)).toEqual({ enabled: true, defaults: {} });
    expect(
      sanitizeDelegateSettings({
        enabled: false,
        defaults: { coding: 'codex', prd: 'cursor', x: 'claude' },
      }),
    ).toEqual({ enabled: false, defaults: { coding: 'codex' } });
  });

  it('截断保留结尾', () => {
    expect(tailText('abcdef', 3)).toBe('…def');
    expect(tailText(' ab ', 3)).toBe('ab');
  });
});
