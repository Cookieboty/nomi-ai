/**
 * 连接动作给用户看的文案（确认卡片、核对卡片）：跟界面语言走（electron 词典）。
 * ConnectionService.ts 里给模型的工具描述是保留的中文（keepZh），用户可见文案放在这里。
 */
import { t } from '../i18n';

export const githubCommentSummary = (repo: string, n: number) =>
  t('electron.common.github-comment-summary', repo, n);

export const githubPrSummary = (repo: string, head: string, base: string) =>
  t('electron.common.github-pr-summary', repo, head, base);
