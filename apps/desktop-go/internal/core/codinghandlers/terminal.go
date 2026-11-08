package codinghandlers

// harness.openTerminal：在会话的项目目录打开终端（快捷键「在终端打开当前项目」）。

import (
	"errors"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/terminal"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// RegisterOpenTerminal：check = 工作目录规则（与编程助手同一套，返回不认的原因；"" = 可以），open = 打开终端
func RegisterOpenTerminal(r *contract.Router, check func(dir string) string, open func(dir string) error) {
	plain(r, "harness.openTerminal", func(a in) any {
		dir := util.Str(a.o.Get("cwd"))
		// 视图带来的目录内核再校验：没有规则时一律不认
		reason := "unavailable"
		if dir != "" && check != nil {
			reason = check(dir)
		}
		if reason != "" {
			panic(&contract.Error{Code: "TERMINAL_CWD_DENIED", Message: reason})
		}
		if err := open(dir); err != nil {
			if errors.Is(err, terminal.ErrNoTerminal) {
				panic(&contract.Error{Code: "TERMINAL_NOT_FOUND", Message: "no terminal program found"})
			}
			throwIf(err)
		}
		return true
	})
}
