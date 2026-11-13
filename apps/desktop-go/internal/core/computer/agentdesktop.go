// Package computer：桌面级 Computer Use。通过无障碍树操作本机原生应用（不移动真实鼠标、不抢焦点），
// 执行器是 agent-desktop CLI（https://github.com/vercel-labs/agent-desktop，Apache-2.0，JSON 契约 2.x）。
// 权限确认、审计、数据外发检查在 igtools 的 computer_* 工具里做；这里只管调用、ref 缓存和安全判定。
package computer

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// Error：agent-desktop 的结构化错误（error.code 见 https://agent-browser.dev/desktop/errors-and-recovery），
// 以及本包自己的错误码（unavailable / blocked_app / unknown_ref / bad_output）
type Error struct {
	Code    string
	Message string
	// Retry：error.disposition.retry（safe / unsafe）
	Retry      string
	Suggestion string
	Details    json.RawMessage
}

func (e *Error) Error() string {
	msg := e.Message
	if e.Suggestion != "" {
		msg += "（" + e.Suggestion + "）"
	}
	if len(e.Details) > 0 && string(e.Details) != "null" {
		d := string(e.Details)
		if len(d) > 1500 {
			d = d[:1500] + "…"
		}
		msg += " details=" + d
	}
	return msg
}

func errf(code, format string, a ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, a...)}
}

// CodeOf：取错误码（非 *Error 返回 ""）
func CodeOf(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}

type envelope struct {
	Version string          `json:"version"`
	OK      bool            `json:"ok"`
	Command string          `json:"command"`
	Data    json.RawMessage `json:"data"`
	Error   *struct {
		Code        string          `json:"code"`
		Message     string          `json:"message"`
		Suggestion  string          `json:"suggestion"`
		Details     json.RawMessage `json:"details"`
		Disposition struct {
			Retry string `json:"retry"`
		} `json:"disposition"`
	} `json:"error"`
}

// ExecFn：跑一次 CLI，返回 stdout。退出码非 0 时 agent-desktop 照样在 stdout 打印 envelope，
// 所以 err 只在 stdout 解析不出 envelope 时才有意义。
type ExecFn func(ctx context.Context, bin string, args []string, stdin string) ([]byte, error)

// HideConsole：Windows 上启动这次命令时不建控制台窗口。
// agent-desktop 和 npm 的全局安装是 .cmd 垫片，直接 CreateProcess 会弹出 cmd 窗口
// （默认终端是 Windows Terminal 时只设 HideWindow 也不够，要 CREATE_NO_WINDOW）。
func HideConsole(cmd *exec.Cmd) { hideWindow(cmd) }

func defaultExec(ctx context.Context, bin string, args []string, stdin string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, bin, args...)
	HideConsole(cmd)
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	cmd.WaitDelay = 2 * time.Second
	err := cmd.Run()
	if err != nil && out.Len() == 0 {
		msg := strings.TrimSpace(errb.String())
		if len(msg) > 500 {
			msg = msg[:500]
		}
		if msg != "" {
			return nil, fmt.Errorf("%w: %s", err, msg)
		}
	}
	return out.Bytes(), err
}

// parseEnvelope：stdout 是一个 JSON envelope；兜底取最后一行（前面可能有告警）
func parseEnvelope(out []byte) (*envelope, error) {
	var env envelope
	if err := json.Unmarshal(bytes.TrimSpace(out), &env); err == nil && (env.Command != "" || env.Error != nil || env.OK) {
		return &env, nil
	}
	lines := bytes.Split(bytes.TrimSpace(out), []byte("\n"))
	for i := len(lines) - 1; i >= 0; i-- {
		l := bytes.TrimSpace(lines[i])
		if len(l) == 0 || l[0] != '{' {
			continue
		}
		if err := json.Unmarshal(l, &env); err == nil {
			return &env, nil
		}
	}
	return nil, errf("bad_output", "agent-desktop 输出无法解析")
}

// call：执行一条操作桌面的 agent-desktop 命令，成功返回 data。隔离模式下经 `sandbox exec <名字> --` 在沙箱里执行
func (s *Service) call(ctx context.Context, timeout time.Duration, stdin string, args ...string) (json.RawMessage, error) {
	return s.run(ctx, timeout, stdin, false, args)
}

// callHost：在这台电脑上执行（版本、沙箱管理），不进沙箱、不算「在操作桌面」
func (s *Service) callHost(ctx context.Context, timeout time.Duration, args ...string) (json.RawMessage, error) {
	return s.run(ctx, timeout, "", true, args)
}

func (s *Service) run(ctx context.Context, timeout time.Duration, stdin string, host bool, args []string) (json.RawMessage, error) {
	bin := s.Bin()
	if bin == "" {
		return nil, errf("unavailable", "没有找到 agent-desktop，先安装：npm install -g agent-desktop（或 brew install agent-desktop）")
	}
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	name := args[0]
	if !host {
		end, err := s.begin(ctx, cancel)
		if err != nil {
			return nil, err
		}
		defer end()
		if sb := s.Settings().Sandbox; sb != "" {
			args = append([]string{"sandbox", "exec", sb, "--"}, args...)
		}
	}
	out, runErr := s.exec(cctx, bin, args, stdin)
	if cctx.Err() != nil && ctx.Err() == nil {
		if errors.Is(cctx.Err(), context.Canceled) {
			return nil, errStopped()
		}
		return nil, errf("TIMEOUT", "agent-desktop %s 超时（%s）", name, timeout)
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	env, err := parseEnvelope(out)
	if err != nil {
		if runErr != nil {
			return nil, errf("bad_output", "agent-desktop %s 失败：%v", name, runErr)
		}
		return nil, err
	}
	if !env.OK {
		if env.Error == nil {
			return nil, errf("INTERNAL", "agent-desktop %s 失败", name)
		}
		return nil, &Error{Code: env.Error.Code, Message: env.Error.Message, Suggestion: env.Error.Suggestion,
			Details: env.Error.Details, Retry: env.Error.Disposition.Retry}
	}
	return env.Data, nil
}
