/** 右栏「让助手提交」：把未提交的文件列表整理成一条指令，填进输入框交给当前 CLI 执行 */
import { t } from '@nomi-ai/ui';

/** 列表太长时只列前面这些，其余给个数 */
const MAX_LISTED = 40;

export interface CommitPromptFile {
  path: string;
  staged: boolean;
  unstaged: boolean;
}

export function buildCommitPrompt(files: readonly CommitPromptFile[], push: boolean): string {
  const listed = files.slice(0, MAX_LISTED).map((f) => {
    const mark = f.staged
      ? f.unstaged
        ? t('ui.session-workspace.partly-staged')
        : t('ui.session-workspace.staged-parens')
      : '';
    return `- ${f.path}${mark}`;
  });
  if (files.length > MAX_LISTED) {
    listed.push(`- ${t('ui.foundation.and-more-files', String(files.length - MAX_LISTED))}`);
  }
  return [
    t(
      'ui.session-workspace.please-commit-the-following-uncommitted-changes-files',
      String(files.length),
    ),
    ...listed,
    '',
    t('ui.session-workspace.write-conventional-commits-messages-following-the-repo-conventions'),
    t('ui.session-workspace.do-not-use-no-verify-if-a-hook'),
    push
      ? t('ui.session-workspace.after-committing-run-a-plain-git-push-use')
      : t('ui.session-workspace.commit-only-do-not-push'),
    t('ui.session-workspace.when-done-list-each-commit-hash-and-subject'),
  ].join('\n');
}
