/**
 * nomi/no-cli-literal（docs/design/cli-plugin-architecture.md §7.3）：核心目录不按内置编程助手名字分支。
 */
import { Linter, RuleTester } from 'eslint';
import { parser as tsParser } from 'typescript-eslint';
import { afterAll, describe, expect, it } from 'vitest';

import { CLI_LITERAL_ALLOWLIST } from '../eslint/cli-literal-allowlist.mjs';
import nomiPlugin, { builtinCliIds } from '../eslint/nomi-plugin.mjs';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.afterAll = afterAll;

const tester = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'module' } });

describe('nomi/no-cli-literal', () => {
  it('内置 id 来自 cli-plugins 的生成文件', () => {
    expect(builtinCliIds()).toEqual(expect.arrayContaining(['claude', 'codex', 'grok']));
  });

  tester.run('no-cli-literal', nomiPlugin.rules['no-cli-literal'], {
    valid: [
      // 按能力位判断、Nomi 自己、非比较的用法都不算
      'if (caps.officialAccount) run();',
      "if (backend === 'nomi') run();",
      "const label = { claude: 'Claude Code' };",
      "send('claude');",
    ],
    invalid: [
      { code: "if (backend === 'claude') run();", errors: [{ messageId: 'branch' }] },
      { code: "if ('codex' !== kind) run();", errors: [{ messageId: 'branch' }] },
      {
        code: "switch (b) { case 'grok': break; case 'gemini': break; }",
        errors: [{ messageId: 'branch' }, { messageId: 'branch' }],
      },
    ],
  });

  it('白名单只列存在的文件，并且很短', async () => {
    const fs = await import('node:fs');
    for (const f of CLI_LITERAL_ALLOWLIST) expect(fs.existsSync(f)).toBe(true);
    expect(CLI_LITERAL_ALLOWLIST.length).toBeLessThanOrEqual(15);
  });

  it('白名单是 shrink-only：每个豁免文件现在确实仍按内置 id 分支（条目陈旧就删掉）', async () => {
    const fs = await import('node:fs');
    const linter = new Linter();
    const stale: string[] = [];
    for (const file of CLI_LITERAL_ALLOWLIST) {
      // 必须带 filename：TS 解析器按扩展名做泛型 / JSX 消歧，否则在泛型处 fatal parse error，
      // 规则根本没执行，会被误判成「零命中=陈旧」。
      const messages = linter.verify(
        fs.readFileSync(file, 'utf8'),
        [
          {
            files: ['**'],
            plugins: { nomi: nomiPlugin },
            languageOptions: {
              ecmaVersion: 2022,
              sourceType: 'module',
              parser: tsParser,
              parserOptions: { ecmaFeatures: { jsx: true } },
            },
            rules: { 'nomi/no-cli-literal': 'error' },
          },
        ],
        { filename: file },
      );
      const fatal = messages.find((m) => m.fatal);
      if (fatal) throw new Error(`${file}: ${fatal.message} (${fatal.line}:${fatal.column})`);
      if (!messages.some((m) => m.ruleId === 'nomi/no-cli-literal')) stale.push(file);
    }
    expect(stale).toEqual([]);
  });
});
