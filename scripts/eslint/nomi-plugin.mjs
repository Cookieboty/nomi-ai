// @ts-check
/**
 * 仓库自己的 ESLint 规则（docs/design/cli-plugin-architecture.md §7.3）。
 *
 * nomi/no-cli-literal：核心目录里不能按内置编程助手的名字分支（`backend === 'claude'`、`case 'codex':`）。
 * 某个 CLI 的特殊行为应该放进它的插件（@nomi-ai/cli-plugins），核心代码按能力位判断；
 * 这样新增一个 CLI（包括外部插件）时不用到处找 if 分支。确实需要按名字处理的地方登记在
 * scripts/eslint/cli-literal-allowlist.mjs，每一项写明原因。
 *
 * 内置 id 从 cli-plugins 的生成文件读取（与插件目录同步，不在这里写死）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const IDS_FILE = path.resolve(here, '../../packages/cli-plugins/src/generated/ids.ts');

/** @returns {string[]} */
export function builtinCliIds() {
  const src = fs.readFileSync(IDS_FILE, 'utf8');
  const m = /BUILTIN_CLI_IDS\s*=\s*\[([^\]]*)\]/.exec(src);
  if (!m) throw new Error(`cannot read BUILTIN_CLI_IDS from ${IDS_FILE}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

const IDS = new Set(builtinCliIds());

/** @type {import('eslint').Rule.RuleModule} */
const noCliLiteral = {
  meta: {
    type: 'suggestion',
    docs: {
      description: '核心目录里不按内置编程助手的名字分支；把差异放进插件，按能力位判断',
    },
    schema: [],
    messages: {
      branch:
        "不要按编程助手名字 '{{id}}' 分支：把这个差异放进 @nomi-ai/cli-plugins 的插件，核心按能力位判断" +
        '（确有必要时登记到 scripts/eslint/cli-literal-allowlist.mjs 并写明原因）',
    },
  },
  create(context) {
    /** @param {any} node */
    const check = (node) => {
      if (node && node.type === 'Literal' && typeof node.value === 'string' && IDS.has(node.value))
        context.report({ node, messageId: 'branch', data: { id: node.value } });
    };
    return {
      /** @param {any} node */
      BinaryExpression(node) {
        if (!['===', '!==', '==', '!='].includes(node.operator)) return;
        check(node.left);
        check(node.right);
      },
      /** @param {any} node */
      SwitchCase(node) {
        check(node.test);
      },
    };
  },
};

export default {
  meta: { name: 'nomi' },
  rules: { 'no-cli-literal': noCliLiteral },
};
