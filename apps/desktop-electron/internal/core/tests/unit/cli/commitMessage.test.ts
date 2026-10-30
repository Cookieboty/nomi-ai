import { cleanCommitMessage, commitMessagePrompt } from '../../../src/cli/commitMessage';

describe('commitMessage', () => {
  it('清掉代码块、前缀、引号、思考和多余空行', () => {
    expect(cleanCommitMessage('```text\nfix: a\n\nbody  \n```')).toBe('fix: a\n\nbody');
    expect(cleanCommitMessage('Commit message: "feat: b"')).toBe('feat: b');
    expect(cleanCommitMessage('<think>hmm</think>\n提交信息：feat: c\n\n\n\nmore')).toBe(
      'feat: c\n\nmore',
    );
    expect(cleanCommitMessage('   ')).toBe('');
  });

  it('提示词带上最近的提交、文件列表和 diff，截断时说明', () => {
    const [sys, user] = commitMessagePrompt({
      subjects: ['feat(ui): 一'],
      stat: ' a.ts | 1 +',
      diff: '+x',
      truncated: true,
    });
    expect(sys!.role).toBe('system');
    expect(user!.content).toContain('- feat(ui): 一');
    expect(user!.content).toContain(' a.ts | 1 +');
    expect(user!.content).toContain('Diff (truncated):\n+x');
  });
});
