/**
 * 命令的确定性分类（docs/design/connections.md §4.4；persistent-tasks.md §8.4）：在辅助模型审核之前、不靠模型。
 *
 * - credential：读凭据（`gh auth token`、`gh auth status --show-token`、macOS `security find-*-password`、
 *   读 gh / git / netrc 的凭据文件）→ 后台任务里一律停下来等人；
 * - never：合并、发布、删仓库、改密钥、强推 → 永远要人逐次决定；
 * - external：对外的副作用（评论、开 PR、写方法的 gh api、`git push`、触发工作流）→ 需要 L4 授权，否则停下来等人；
 * - null：不在以上之列，交给命令审核照常判断。
 *
 * 只是默认防线，不是安全边界（编程助手仍可能换别的方式）；真正的边界是任务授权与逐次审批。
 * Go 版：apps/desktop-go/internal/core/desktop/command_class.go；用例共用 testdata/command-class.json。
 */
export type CommandClass = 'credential' | 'never' | 'external';

const SEP = /&&|\|\||;|\||\n/;
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const CRED_FILES = /(\.config\/gh\/hosts\.yml|\.git-credentials|\.netrc|_netrc)\b/;

const RANK: Record<CommandClass, number> = { external: 1, never: 2, credential: 3 };

/** 粗略分词：引号内不拆（够判断子命令与参数，不追求完整 shell 语法） */
function words(seg: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(seg))) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

function classifySegment(seg: string): CommandClass | null {
  if (CRED_FILES.test(seg)) return 'credential';
  let w = words(seg.trim());
  while (
    w.length &&
    (ENV_ASSIGN.test(w[0]!) || w[0] === 'sudo' || w[0] === 'env' || w[0] === 'command')
  )
    w = w.slice(1);
  if (!w.length) return null;
  const bin = w[0]!.split('/').pop()!;
  const [a, b] = [w[1] ?? '', w[2] ?? ''];
  const rest = w.slice(1);
  const has = (...flags: string[]) =>
    rest.some((x) => flags.includes(x) || flags.some((f) => x.startsWith(`${f}=`)));

  if (bin === 'security' && /^(find-(generic|internet)-password|dump-keychain|export)$/.test(a))
    return 'credential';
  if (bin === 'gh') {
    if (a === 'auth' && (b === 'token' || (b === 'status' && has('--show-token', '-t'))))
      return 'credential';
    if (a === 'pr' && b === 'merge') return 'never';
    if (a === 'release' && ['create', 'delete', 'upload', 'edit'].includes(b)) return 'never';
    if (a === 'repo' && ['delete', 'archive', 'edit', 'rename'].includes(b)) return 'never';
    if (a === 'repo' && ['create', 'fork'].includes(b)) return 'external';
    if (a === 'secret' || a === 'variable')
      return ['set', 'delete', 'remove'].includes(b) ? 'never' : null;
    if (
      a === 'issue' &&
      ['create', 'comment', 'close', 'reopen', 'edit', 'delete', 'lock', 'transfer'].includes(b)
    )
      return 'external';
    if (
      a === 'pr' &&
      ['create', 'comment', 'review', 'close', 'reopen', 'edit', 'ready'].includes(b)
    )
      return 'external';
    if (a === 'workflow' && ['run', 'enable', 'disable'].includes(b)) return 'external';
    if (a === 'run' && ['rerun', 'cancel', 'delete'].includes(b)) return 'external';
    if (a === 'api') {
      const i = rest.findIndex((x) => x === '-X' || x === '--method' || /^(-X|--method=)/.test(x));
      const method = (() => {
        if (i < 0) return '';
        const x = rest[i]!;
        if (x === '-X' || x === '--method') return (rest[i + 1] ?? '').toUpperCase();
        return x.replace(/^(-X|--method=)/, '').toUpperCase();
      })();
      if (method === 'DELETE' && rest.some((x) => /\/repos\/[^/]+\/[^/]+\/?$/.test(x)))
        return 'never';
      if (/merge/.test(rest.join(' ')) && method && method !== 'GET') return 'never';
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) return 'external';
      // 带字段参数而没写方法：gh api 默认改成 POST
      if (!method && has('-f', '-F', '--field', '--raw-field', '--input')) return 'external';
      return null;
    }
    return null;
  }
  if (bin === 'git') {
    if (a === 'credential' && ['fill', 'get'].includes(b)) return 'credential';
    if (a === 'push') {
      if (
        has('--force', '-f', '--force-with-lease', '--mirror', '--delete', '-d') ||
        rest.some((x) => x.startsWith('+'))
      )
        return 'never';
      return 'external';
    }
  }
  return null;
}

/** 整条命令里最严重的一类（按 ; && || | 换行拆开逐段判断） */
export function classifyCommand(command: string): CommandClass | null {
  let worst: CommandClass | null = null;
  for (const seg of command.split(SEP)) {
    const c = classifySegment(seg);
    if (c && (!worst || RANK[c] > RANK[worst])) worst = c;
  }
  return worst;
}
