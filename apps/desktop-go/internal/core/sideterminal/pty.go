// Package sideterminal 管理右侧工作区内置交互式终端的跨平台 PTY 会话生命周期。
package sideterminal

import (
	"errors"
	"os"
	"strings"
)

// ErrUnsupported 表示当前系统或环境不支持内置交互式伪终端（例如过于老旧的 Windows 缺少 ConPTY）。
var ErrUnsupported = errors.New("pty unsupported")

// PTY 是跨平台伪终端会话接口（macOS/Linux 使用 /dev/ptmx，Windows 使用 ConPTY）。
type PTY interface {
	Read(p []byte) (int, error)
	Write(p []byte) (int, error)
	Resize(cols, rows uint16) error
	Wait() (exitCode int, signal string, err error)
	Close() error
	Shell() string
}

// StartOptions 描述启动 PTY 进程时的初始目录、尺寸和环境变量。
type StartOptions struct {
	Dir  string
	Cols uint16
	Rows uint16
	Env  []string
}

const (
	defaultCols = 80
	defaultRows = 24
	minCols     = 10
	maxCols     = 500
	minRows     = 4
	maxRows     = 200
)

func clampSize(cols, rows int) (uint16, uint16) {
	if cols <= 0 {
		cols = defaultCols
	} else if cols < minCols {
		cols = minCols
	} else if cols > maxCols {
		cols = maxCols
	}
	if rows <= 0 {
		rows = defaultRows
	} else if rows < minRows {
		rows = minRows
	} else if rows > maxRows {
		rows = maxRows
	}
	return uint16(cols), uint16(rows)
}

func buildEnv(base []string, unixLocale bool) []string {
	src := base
	if src == nil {
		src = os.Environ()
	}
	out := make([]string, 0, len(src)+4)
	hasLang := false
	hasLCAll := false
	for _, kv := range src {
		k, _, ok := strings.Cut(kv, "=")
		if !ok {
			continue
		}
		switch {
		case strings.EqualFold(k, "TERM") || strings.EqualFold(k, "COLORTERM") || strings.EqualFold(k, "TERM_PROGRAM"):
			continue
		case k == "LANG":
			hasLang = true
		case k == "LC_ALL":
			hasLCAll = true
		}
		out = append(out, kv)
	}
	out = append(out,
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
		"TERM_PROGRAM=Nomi",
	)
	if unixLocale && !hasLang && !hasLCAll {
		out = append(out, "LANG=en_US.UTF-8")
	}
	return out
}
