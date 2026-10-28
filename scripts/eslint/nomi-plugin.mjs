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

/** @param {any} node */
const isElectronLiteral = (node) =>
  !!node &&
  ((node.type === 'Literal' && node.value === 'electron') ||
    (node.type === 'TemplateLiteral' &&
      node.expressions.length === 0 &&
      node.quasis[0]?.value.cooked === 'electron'));

const REQUIRE_LIKE = /require/i;

/**
 * 一个表达式是不是「require 函数」：
 * - 名字里带 require 的标识符（require / nodeRequire / requireFn …）；
 * - 调用 require 类函数得到的结果（createRequire(url)、nodeRequire()）；
 * - 用上面两种初始化的 const 变量（`const req = nodeRequire(); req('electron')`）。
 * @param {any} node
 * @param {any} scope
 * @param {number} depth
 * @returns {boolean}
 */
function isRequireLike(node, scope, depth = 0) {
  if (!node || depth > 3) return false;
  if (node.type === 'Identifier') {
    if (REQUIRE_LIKE.test(node.name)) return true;
    // 沿作用域找变量定义：初始化表达式是 require 类调用时同样算
    for (let s = scope; s; s = s.upper) {
      const v = s.set.get(node.name);
      if (!v) continue;
      for (const def of v.defs) {
        if (def.type === 'Variable' && def.node.init && def.node.init.type === 'CallExpression') {
          if (isRequireLike(def.node.init.callee, s, depth + 1)) return true;
        }
      }
      return false;
    }
    return false;
  }
  if (node.type === 'CallExpression') return isRequireLike(node.callee, scope, depth + 1);
  if (node.type === 'TSAsExpression' || node.type === 'TSNonNullExpression')
    return isRequireLike(node.expression, scope, depth + 1);
  return false;
}

/**
 * nomi/no-dynamic-electron：非宿主代码里不能动态加载 electron（docs/design/core-host-decoupling.md §11.1）。
 * 只看 require 类调用（见 isRequireLike）与 `import('electron')`，不误报 `set.has('electron')`、
 * `jest.mock('electron')` 这类普通方法调用。既有用法登记在 scripts/eslint/electron-boundary.mjs。
 * @type {import('eslint').Rule.RuleModule}
 */
const noDynamicElectron = {
  meta: {
    type: 'problem',
    docs: { description: '非宿主代码不能用 require / createRequire / import() 动态加载 electron' },
    schema: [],
    messages: {
      dynamic:
        '非宿主代码不能动态加载 electron：平台能力走宿主端口（docs/design/core-host-decoupling.md §6、§11.1），' +
        '宿主代码放 packages/electron/src/host/',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    return {
      /** @param {any} node */
      CallExpression(node) {
        if (!isElectronLiteral(node.arguments[0])) return;
        if (isRequireLike(node.callee, sourceCode.getScope(node)))
          context.report({ node, messageId: 'dynamic' });
      },
      /** @param {any} node */
      ImportExpression(node) {
        if (isElectronLiteral(node.source)) context.report({ node, messageId: 'dynamic' });
      },
    };
  },
};

export default {
  meta: { name: 'nomi' },
  rules: { 'no-cli-literal': noCliLiteral, 'no-dynamic-electron': noDynamicElectron },
};
