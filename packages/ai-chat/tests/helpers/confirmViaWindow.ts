/**
 * vi.mock('../src/components/ConfirmDialog', () => import('./helpers/confirmViaWindow'))：
 * 让应用内确认框在单测里走 window.confirm / window.prompt，沿用各测试已有的 confirm mock 与文案断言。
 * 真实弹窗的交互由 confirmDialog.test.tsx 与侧栏 / 菜单测试覆盖。
 */
import type { ConfirmOptions, PromptOptions } from '../../src/components/ConfirmDialog';

const text = (o: ConfirmOptions) =>
  typeof o.message === 'string' ? o.message : String(o.title ?? '');

export const confirmDialog = async (o: ConfirmOptions): Promise<boolean> => window.confirm(text(o));

export const promptDialog = async (o: PromptOptions): Promise<string | null> =>
  window.prompt(o.title, o.defaultValue);

export const resetConfirmDialogForTest = (): void => undefined;
