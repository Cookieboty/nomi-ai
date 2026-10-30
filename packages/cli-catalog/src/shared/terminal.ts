/**
 * 终端命令的共用部分：按平台把「设环境变量再运行 CLI」拼成一行（只含路径与参数，不含凭据）。
 * 纯函数，渲染进程也能用。
 */

/** POSIX shell 单引号转义 */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** PowerShell 单引号转义 */
export function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** 一行命令：env 先设好，再运行 command args（POSIX：`A=1 cmd`；Windows PowerShell：`$env:A='1'; cmd`） */
export function terminalLine(
  o: { command: string; args: string[]; env: Record<string, string> },
  platform: string,
): string {
  if (platform === 'win32') {
    const sets = Object.entries(o.env).map(([k, v]) => `$env:${k}=${psQuote(v)}; `);
    return `${sets.join('')}${[o.command, ...o.args.map(psQuote)].join(' ')}`;
  }
  const sets = Object.entries(o.env).map(([k, v]) => `${k}=${shQuote(v)} `);
  return `${sets.join('')}${[o.command, ...o.args.map(shQuote)].join(' ')}`;
}
