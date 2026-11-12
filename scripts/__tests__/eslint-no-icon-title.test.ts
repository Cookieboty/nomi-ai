/**
 * nomi/no-icon-title（docs/development/frontend-standards.md「无障碍与提示」）：
 * 图标按钮一律不加原生 title，可访问名只走 aria-label。
 */
import { RuleTester } from 'eslint';
import { parser as tsParser } from 'typescript-eslint';
import { afterAll, describe, it } from 'vitest';

import nomiPlugin from '../eslint/nomi-plugin.mjs';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.afterAll = afterAll;

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    parser: tsParser,
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

describe('nomi/no-icon-title', () => {
  tester.run('no-icon-title', nomiPlugin.rules['no-icon-title'], {
    valid: [
      // 图标按钮用 aria-label 命名
      '<IconButton icon={<Icon />} label="设置" onClick={run} />',
      '<button type="button" aria-label="设置" onClick={run}><Icon /></button>',
      // 带可见文字的按钮也不再写 title
      '<Button onClick={run}>保存</Button>',
      // 文本截断后用 title 展示全文：允许的用法
      '<span className={styles.path} title={file.path}>{file.path}</span>',
      '<td title={model.id}>{model.id}</td>',
      // 组件的 title 属性是标题文案，不是原生提示
      '<EmptyState icon={Terminal} title={t("ui.cli-monitor.fleet")} />',
      '<SettingRow title={t("ui.foundation.theme")} />',
    ],
    invalid: [
      {
        code: '<IconButton icon={<Icon />} label="设置" title="设置" onClick={run} />',
        errors: [{ messageId: 'iconTitle' }],
      },
      {
        code: '<UI.IconButton label="收起" title="收起" icon={<Icon />} />',
        errors: [{ messageId: 'iconTitle' }],
      },
      {
        code: '<MyIconButton icon={<Icon />} title="收起" />',
        errors: [{ messageId: 'iconTitle' }],
      },
      {
        code: '<Button title="关闭"><Icon /></Button>',
        errors: [{ messageId: 'iconTitle' }],
      },
      {
        code: '<button type="button" title="关闭"><Icon /></button>',
        errors: [{ messageId: 'iconTitle' }],
      },
      {
        code: '<a href={href} title={href}><Icon /></a>',
        errors: [{ messageId: 'iconTitle' }],
      },
      {
        code: '<div role="button" title="放大" onClick={zoom}><Icon /></div>',
        errors: [{ messageId: 'iconTitle' }],
      },
    ],
  });
});
