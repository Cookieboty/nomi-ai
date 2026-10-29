package terminal

import (
	"context"
	"encoding/base64"
	"os"
	"os/exec"
	"strings"
	"time"
	"unicode/utf16"
)

// windowsPathScript：windowsPath.ts 的 PowerShell 原文（只改当前用户 PATH，保留未展开变量与值类型）
const windowsPathScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {
  $value = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
  if ($key.GetValueNames() -contains 'Path') { $kind = $key.GetValueKind('Path') }
  $target = $env:NOMI_PATH_DIRECTORY.TrimEnd('\')
  $parts = @(([string]$value).Split(';'))
  $found = @($parts | Where-Object { $_.Trim().Trim('"').TrimEnd('\') -ieq $target }).Count -gt 0
  $changed = $false
  if ($env:NOMI_PATH_ADD -eq '1' -and !$found) {
    $next = if ([string]::IsNullOrEmpty($value)) { $target } else { $value + ';' + $target }
    $changed = $true
  } elseif ($env:NOMI_PATH_ADD -eq '0' -and $found) {
    $next = (@($parts | Where-Object { $_.Trim().Trim('"').TrimEnd('\') -ine $target }) -join ';')
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
`

// EncodedCommand：Buffer.from(script, 'utf16le').toString('base64')
func EncodedCommand(script string) string {
	w := utf16.Encode([]rune(script))
	b := make([]byte, len(w)*2)
	for i, c := range w {
		b[2*i], b[2*i+1] = byte(c), byte(c>>8)
	}
	return base64.StdEncoding.EncodeToString(b)
}

// PathArgs：传给 powershell.exe 的 argv（单测比对）
func PathArgs() []string {
	return []string{"-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", EncodedCommand(windowsPathScript)}
}

// UpdateWindowsPath = updateWindowsPath(directory, add)；失败时 Node 抛错（set 调用链向上抛），这里 panic 同等传播
func UpdateWindowsPath(directory string, add bool) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "powershell.exe", PathArgs()...)
	flag := "0"
	if add {
		flag = "1"
	}
	cmd.Env = append(os.Environ(), "NOMI_PATH_DIRECTORY="+directory, "NOMI_PATH_ADD="+flag)
	hideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		panic(err)
	}
	return strings.TrimSpace(string(out)) == "1"
}
