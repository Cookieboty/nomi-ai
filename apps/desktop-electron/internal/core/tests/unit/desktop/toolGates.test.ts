import type { ToolDefinition } from '@nomi-ai/bundle-ig-base';

import { applyToolGates, TOOL_GATES } from '../../../src/desktop/toolGates';

/** 与 Go igtools/gates_test.go 同一组语料 */
const CASES: Array<[string, string, boolean, string?]> = [
  ['reminder_create', '明早八点提醒我开会', true],
  ['reminder_create', '你好呀', false],
  ['clipboard_read', '看看我剪贴板里是什么', true],
  ['browser_open', '帮我打开 https://example.com', true],
  ['browser_open', '今天心情不错', false],
  ['code_run', '帮我算一下 17 的阶乘', true],
  ['random', '掷个骰子', true],
  ['echo', '随便说点什么', false],
  ['fs_write_text', '把这段话保存到桌面', true],
  ['fs_write_text', '讲个笑话', false],
  ['fs_write_text', '讲个笑话', true, '/Users/me/proj'],
  ['delegate_to_cli', '让 codex 修一下这个 bug', true],
  ['delegate_to_cli', '晚饭吃什么', false],
  ['image_generate', '画一只猫', true],
  ['image_generate', '晚饭吃什么', false],
  ['set_user_preference', '以后叫我小王', true],
  ['undo_last', '撤销刚才的操作', true],
  ['time_now', '你好', true],
];

describe('toolGates', () => {
  // 补齐第 4 列：参数个数多于一行的列数时 jest 会把最后一个当 done 回调
  const rows = CASES.map(([n, t, w, c]) => [n, t, w, c ?? ''] as const);
  it.each(rows)('%s：「%s」→ %s', (name, text, want, cwd) => {
    const gate = TOOL_GATES[name];
    const got = gate
      ? gate({ userText: text, convoText: text.toLowerCase(), ...(cwd ? { cwd } : {}) })
      : true;
    expect(got).toBe(want);
  });

  it('applyToolGates 只给表里的工具挂 relevant，不覆盖工具自己的', () => {
    const own = () => true;
    const defs = new Map<string, ToolDefinition>();
    for (const d of [
      { name: 'reminder_create' },
      { name: 'memory_search' },
      { name: 'random', relevant: own },
    ] as ToolDefinition[])
      defs.set(d.name, d);
    applyToolGates({
      register: (d) => void defs.set(d.name, d as ToolDefinition),
      get: (n) => defs.get(n),
      list: () => [...defs.values()],
    });
    expect(defs.get('reminder_create')!.relevant).toBe(TOOL_GATES.reminder_create);
    expect(defs.get('memory_search')!.relevant).toBeUndefined();
    expect(defs.get('random')!.relevant).toBe(own);
  });
});
