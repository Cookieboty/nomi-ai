//go:build windows

package computer

import (
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestHideConsoleNoWindow(t *testing.T) {
	cmd := exec.Command(`C:\Users\Administrator\AppData\Roaming\npm\agent-desktop.cmd`, "permissions")
	HideConsole(cmd)
	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.HideWindow || cmd.SysProcAttr.CreationFlags&createNoWindow == 0 {
		t.Fatalf("cmd shim window: %+v", cmd.SysProcAttr)
	}
	if !strings.EqualFold(filepath.Base(cmd.Path), "cmd.exe") {
		t.Fatalf("shim should run via cmd.exe, path %s", cmd.Path)
	}
	if !strings.Contains(cmd.SysProcAttr.CmdLine, "agent-desktop.cmd") || !strings.Contains(cmd.SysProcAttr.CmdLine, "/d /s /c") {
		t.Fatalf("cmdline %s", cmd.SysProcAttr.CmdLine)
	}
	exe := exec.Command(`C:\Tools\agent-desktop.exe`, "version")
	HideConsole(exe)
	if !strings.EqualFold(filepath.Base(exe.Path), "agent-desktop.exe") {
		t.Fatalf("exe path changed: %s", exe.Path)
	}
	if exe.SysProcAttr == nil || !exe.SysProcAttr.HideWindow || exe.SysProcAttr.CreationFlags&createNoWindow == 0 {
		t.Fatalf("exe window: %+v", exe.SysProcAttr)
	}
}
