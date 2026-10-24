/**
 * nomi/no-cli-literal（docs/design/cli-plugin-architecture.md §7.3）：核心目录不按内置编程助手名字分支。
 */
import { RuleTester } from 'eslint';
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
});
