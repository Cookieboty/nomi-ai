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
    const mark = f.staged ? (f.unstaged ? t('（部分已暂存）') : t('（已暂存）')) : '';
    return `- ${f.path}${mark}`;
  });
  if (files.length > MAX_LISTED) {
    listed.push(`- ${t('…另有 {0} 个文件', String(files.length - MAX_LISTED))}`);
  }
  return [
    t('请提交以下未提交的改动（{0} 个文件）：', String(files.length)),
    ...listed,
    '',
    t('按仓库约定写 Conventional Commits 提交信息，必要时按主题拆成多个提交。'),
    t('不要使用 --no-verify；钩子失败就修复后重新提交。不要改写已有历史，不要打 tag。'),
    push
      ? t(
          '提交完成后执行普通的 git push（没有上游分支时用 -u origin <当前分支>），不要 force-push。',
        )
      : t('只提交，不要推送。'),
    t('完成后列出每个提交的 hash 和标题。'),
  ].join('\n');
}
