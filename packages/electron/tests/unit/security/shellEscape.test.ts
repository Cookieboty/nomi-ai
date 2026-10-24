import {
  appleScriptQuote,
  cmdEscape,
  cmdQuote,
  psQuote,
  shQuote,
} from '../../../src/security/shellEscape';

describe('shellEscape', () => {
  it('psQuote 双写单引号，阻断引号逃逸', () => {
    expect(psQuote("a'b")).toBe("'a''b'");
    // 典型 PowerShell 注入载荷
    expect(psQuote("x'); Remove-Item C:\\ -Recurse; $y='")).toBe(
      "'x''); Remove-Item C:\\ -Recurse; $y='''",
    );
  });

  it('psQuote 结果始终被单引号包裹', () => {
    const q = psQuote('any $var `cmd`');
    expect(q.startsWith("'") && q.endsWith("'")).toBe(true);
  });

  it('appleScriptQuote 转义反斜杠 / 双引号 / 换行', () => {
    expect(appleScriptQuote('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(appleScriptQuote('line1\nline2')).toBe('"line1\\nline2"');
    expect(appleScriptQuote('tab\there')).toBe('"tab\\there"');
  });

  it('appleScriptQuote 阻断双引号逃逸', () => {
    const q = appleScriptQuote('x" do shell script "id');
    // 去掉被反斜杠转义的引号后，只剩首尾两个包裹引号
    const unescaped = q.replace(/\\"/g, '').match(/"/g);
    expect(unescaped).toEqual(['"', '"']);
  });
});

describe('shQuote / cmdQuote (table-driven quoting surfaces)', () => {
  it.each([
    ['safe', "'safe'"],
    ["it's", "'it'\\''s'"],
    ['$(reboot)', "'$(reboot)'"],
    ['a\nb', "'a\nb'"],
  ])('shQuote(%j)', (input, expected) => {
    expect(shQuote(input)).toBe(expected);
  });

  it.each([
    ['plain', 'plain'],
    ['a b', '"a b"'],
    ['a"b', '"a\\"b"'],
    ['%PATH%', '"%%PATH%%"'],
    ['a&b', '"a&b"'],
  ])('cmdQuote(%j)', (input, expected) => {
    expect(cmdQuote(input)).toBe(expected);
  });

  it('cmdEscape doubles percent and carets metacharacters outside quotes', () => {
    expect(cmdEscape('a%b&c')).toBe('a%%b^&c');
    expect(cmdEscape('"a&b"')).toBe('"a&b"');
  });

  it.each([
    ["a'b", "'a''b'"],
    ['$x; rm', "'$x; rm'"],
    ["x'); Get-Process; '", "'x''); Get-Process; '''"],
  ])('psQuote(%j) table', (input, expected) => {
    expect(psQuote(input)).toBe(expected);
  });
});
