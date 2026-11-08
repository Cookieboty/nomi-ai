package terminal

import (
	"errors"
	"os/exec"
	"runtime"
)

// ErrNoTerminal：本机找不到能打开的终端程序（Linux 上没装常见的终端）
var ErrNoTerminal = errors.New("TERMINAL_NOT_FOUND")

// OpenAt：在 dir 打开一个新的终端窗口（会话里的「在终端打开当前项目」快捷键）。dir 由调用方先校验过。
// macOS 用系统自带的「终端」；Windows 有 Windows Terminal（wt）就用它，否则开 PowerShell；
// Linux 依次试 x-terminal-emulator / gnome-terminal / konsole / xfce4-terminal / xterm。只启动、不等它退出。
func OpenAt(dir string) error {
	return openAt(runtime.GOOS, dir, exec.LookPath, start)
}

func start(c *exec.Cmd) error {
	if err := c.Start(); err != nil {
		return err
	}
	go func() { _ = c.Wait() }() // 收掉子进程，不留僵尸
	return nil
}

// openAt：按平台拼出启动命令（拆出来便于测试）
func openAt(goos, dir string, look func(string) (string, error), run func(*exec.Cmd) error) error {
	switch goos {
	case "darwin":
		return run(exec.Command("open", "-a", "Terminal", dir))
	case "windows":
		if wt, err := look("wt.exe"); err == nil {
			return run(exec.Command(wt, "-d", dir))
		}
		// start 起一个独立的 PowerShell 窗口；/D 设它的工作目录（cmd 本身不弹窗）
		c := exec.Command("cmd.exe", "/c", "start", "", "/D", dir, "powershell.exe", "-NoExit")
		hideWindow(c)
		return run(c)
	default:
		for _, t := range []struct {
			bin  string
			args []string
		}{
			{"x-terminal-emulator", nil},
			{"gnome-terminal", []string{"--working-directory=" + dir}},
			{"konsole", []string{"--workdir", dir}},
			{"xfce4-terminal", []string{"--working-directory=" + dir}},
			{"xterm", nil},
		} {
			p, err := look(t.bin)
			if err != nil {
				continue
			}
			c := exec.Command(p, t.args...)
			c.Dir = dir
			return run(c)
		}
		return ErrNoTerminal
	}
}
