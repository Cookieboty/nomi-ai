/**
 * 右栏「改动」的「生成提交信息」（docs/design/changes-panel-git.md §6 P3）：
 * 把要提交的 diff 和最近的提交标题交给辅助模型（网关的 summary 档，受外发保护），照仓库的风格写一条。
 */
import type { GitCommitContext } from './gitOps';

export interface CommitMessageMsg {
  role: 'system' | 'user';
  content: string;
}

export function commitMessagePrompt(ctx: GitCommitContext): CommitMessageMsg[] {
  return [
    {
      role: 'system',
      content:
        'You write git commit messages. Reply with the commit message only: no code fences, no quotes, no commentary.',
    },
    {
      role: 'user',
      content: [
        'Write a commit message for the change below.',
        "- Match the style of the repository's recent commits: their language, whether they use Conventional Commits and which scopes, and their length.",
        '- Keep every line under 100 characters. Subject first; add a short body after a blank line only if the change needs explaining.',
        '- Describe what changed and why, not the file list.',
        '',
        'Recent commits:',
        ctx.subjects.length ? ctx.subjects.map((s) => `- ${s}`).join('\n') : '(none)',
        '',
        'Files:',
        ctx.stat || '(none)',
        '',
        `Diff${ctx.truncated ? ' (truncated)' : ''}:`,
        ctx.diff,
      ].join('\n'),
    },
  ];
}

/** 模型偶尔还是会包一层 ``` 或加「Commit message:」：去掉；每行去尾空白，限制长度 */
export function cleanCommitMessage(raw: string): string {
  let s = raw.replace(/\r\n?/g, '\n').trim();
  // 推理模型可能把思考写在 <think> 里
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(s);
  if (fence) s = fence[1]!.trim();
  s = s.replace(/^(commit message|提交信息)\s*[:：]\s*/i, '');
  s = s.replace(/^["'`]+|["'`]+$/g, '').trim();
  return s
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, 4000)
    .trim();
}
