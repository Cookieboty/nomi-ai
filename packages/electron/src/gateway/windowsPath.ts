import { execFileSync } from 'node:child_process';

/** 只修改当前用户的 PATH，保留未展开的变量和原注册表值类型。目录通过环境传入。 */
export function updateWindowsPath(directory: string, add: boolean): boolean {
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {
  $value = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
  if ($key.GetValueNames() -contains 'Path') { $kind = $key.GetValueKind('Path') }
  $target = $env:NOMI_PATH_DIRECTORY.TrimEnd('\\')
  $parts = @(([string]$value).Split(';'))
  $found = @($parts | Where-Object { $_.Trim().Trim('"').TrimEnd('\\') -ieq $target }).Count -gt 0
  $changed = $false
  if ($env:NOMI_PATH_ADD -eq '1' -and !$found) {
    $next = if ([string]::IsNullOrEmpty($value)) { $target } else { $value + ';' + $target }
    $changed = $true
  } elseif ($env:NOMI_PATH_ADD -eq '0' -and $found) {
    $next = (@($parts | Where-Object { $_.Trim().Trim('"').TrimEnd('\\') -ine $target }) -join ';')
    $changed = $true
  }
  if ($changed) { $key.SetValue('Path', $next, $kind) }
} finally { $key.Dispose() }
# Broadcast is best-effort; registry write already succeeded. Tests can skip the
# cold Add-Type compile with NOMI_SKIP_ENV_BROADCAST=1.
if ($changed -and $env:NOMI_SKIP_ENV_BROADCAST -ne '1') {
  try {
  Add-Type -Namespace Nomi -Name EnvironmentBroadcast -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern System.IntPtr SendMessageTimeout(System.IntPtr h, uint m, System.UIntPtr w, string l, uint f, uint t, out System.UIntPtr r);
'@
  $result = [UIntPtr]::Zero
  [void][Nomi.EnvironmentBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 2000, [ref]$result)
  } catch { }
}
[Console]::Write($(if ($changed) { '1' } else { '0' }))
`;
  // Cold PowerShell 5 + Add-Type on CI runners can exceed 15s; 45s covers that
  // without hanging a hung shell forever. Registry write itself is fast.
  return (
    execFileSync(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      {
        env: { ...process.env, NOMI_PATH_DIRECTORY: directory, NOMI_PATH_ADD: add ? '1' : '0' },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 45_000,
      },
    ).trim() === '1'
  );
}
