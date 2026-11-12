// @ts-check
/**
 * 仓库自己的 ESLint 规则（docs/development/coding-agents.md）。
 *
 * nomi/no-icon-title：图标按钮一律不加原生 title（docs/development/frontend-standards.md「无障碍与提示」）。
 * 可访问名用 aria-label；说明用可见文案或 @nomi-ai/ui 的 Tooltip / FloatingTip。
 *
 * nomi/no-cli-literal：视图里不能按内置编程助手的名字分支（`backend === 'claude'`、`case 'codex':`）。
 * 某个 CLI 的特殊行为应该放进它的插件清单（@nomi-ai/cli-catalog），视图按能力位判断；
 * 这样新增一个 CLI（包括外部插件）时不用到处找 if 分支。确实需要按名字处理的地方登记在
 * scripts/eslint/cli-literal-allowlist.mjs，每一项写明原因。
 *
 * 内置 id 从 cli-catalog 的生成文件读取（不在这里写死）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const IDS_FILE = path.resolve(here, '../../packages/cli-catalog/src/generated/ids.ts');

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

/** 原生交互元素统一不写 title；全文提示放在截断文本上。 */
const INTERACTIVE_TAGS = new Set(['button', 'a', 'summary']);

/** @type {import('eslint').Rule.RuleModule} */
const noIconTitle = {
  meta: {
    type: 'problem',
    docs: {
      description: '图标按钮不加原生 title：可访问名用 aria-label，说明用可见文案或 Tooltip',
    },
    schema: [],
    messages: {
      iconTitle:
        '图标按钮不加原生 title：可访问名用 aria-label；要解释就写进可见文案或用 ' +
        'Tooltip / FloatingTip（docs/development/frontend-standards.md「无障碍与提示」）',
    },
  },
  create(context) {
    /** @param {any} node */
    const isButtonRole = (node) =>
      (node.attributes ?? []).some(
        (a) =>
          a.type === 'JSXAttribute' &&
          a.name?.name === 'role' &&
          a.value?.type === 'Literal' &&
          a.value.value === 'button',
      );
    return {
      /** @param {any} node */
      JSXAttribute(node) {
        if (node.name?.name !== 'title') return;
        const opening = node.parent;
        if (opening?.type !== 'JSXOpeningElement') return;
        const tag = opening.name?.name ?? opening.name?.property?.name ?? '';
        // Button 只渲染图标时也遵守同一约定；带文字的 Button 保留现有说明。
        const children = opening.parent.children ?? [];
        const onlyElements = children.every(
          (child) =>
            child.type === 'JSXElement' ||
            (child.type === 'JSXText' && !child.value.trim()) ||
            (child.type === 'JSXExpressionContainer' &&
              child.expression.type === 'JSXEmptyExpression'),
        );
        const iconButton =
          tag.endsWith('IconButton') ||
          INTERACTIVE_TAGS.has(tag) ||
          (tag === 'Button' && onlyElements && children.some((c) => c.type === 'JSXElement'));
        if (!iconButton && !isButtonRole(opening)) return;
        context.report({ node, messageId: 'iconTitle' });
      },
    };
  },
};

export default {
  meta: { name: 'nomi' },
  rules: { 'no-cli-literal': noCliLiteral, 'no-icon-title': noIconTitle },
};
