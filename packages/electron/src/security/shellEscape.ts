/**
 * 拼接 shell 脚本时的参数转义。spawn 不经 shell 的 argv 形式天然安全；
 * 只有 bash -lc / powershell -Command 这种"把代码拼进脚本字符串"的场景才需要。
 */

/** 包成 PowerShell 单引号字符串字面量（单引号双写），可安全嵌入 '...' 上下文。 */
export function psQuote(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** 包成 AppleScript 双引号字符串字面量。 */
export function appleScriptQuote(s: string): string {
  const escaped = String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

/** 包成 POSIX sh 单引号字符串字面量（单引号写成 '\''），可安全嵌入 sh 脚本。 */
export function shQuote(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * 给 .cmd 脚本里已经组好的一段文字补 cmd 转义：`%` 写成 `%%`；cmd 自己按 `"` 切换引号状态，
 * 引号外的 `^ & | < > ( )` 前加 `^`。不处理延迟展开（脚本不开 EnableDelayedExpansion）。
 */
export function cmdEscape(s: string): string {
  let out = '';
  let quoted = false;
  for (const ch of String(s)) {
    if (ch === '"') quoted = !quoted;
    if (ch === '%') out += '%%';
    else if (!quoted && '^&|<>()'.includes(ch)) out += `^${ch}`;
    else out += ch;
  }
  return out;
}

/**
 * 一个命令行参数在 .cmd 里的写法：先按 Windows 程序的 argv 规则（CommandLineToArgvW）加引号，
 * 再做 cmd 转义。
 */
export function cmdQuote(s: string): string {
  const v = String(s);
  if (v && !/[\s"^&|<>()%!]/.test(v)) return v;
  let q = '"';
  let bs = 0;
  for (const ch of v) {
    if (ch === '\\') {
      bs++;
      continue;
    }
    if (ch === '"') q += '\\'.repeat(bs * 2 + 1) + '"';
    else q += '\\'.repeat(bs) + ch;
    bs = 0;
  }
  q += '\\'.repeat(bs * 2) + '"';
  return cmdEscape(q);
}
