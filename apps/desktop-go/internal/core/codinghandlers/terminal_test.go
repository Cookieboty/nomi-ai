package codinghandlers

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/terminal"
)

// 在终端打开项目：目录先按工作目录规则校验，不认的不打开；找不到终端时给明确的错误码
func TestOpenTerminal(t *testing.T) {
	var opened []string
	open := func(dir string) error { opened = append(opened, dir); return nil }
	check := func(dir string) string {
		if dir == "/" {
			return "too broad"
		}
		return ""
	}
	r := contract.NewRouter()
	RegisterOpenTerminal(r, check, open)
	if fr := callAccounts(t, r, "harness.openTerminal", map[string]any{"cwd": "/w/app"}); fr.T != "res" {
		t.Fatalf("ok: %+v", fr)
	}
	for _, dir := range []string{"/", ""} {
		fr := callAccounts(t, r, "harness.openTerminal", map[string]any{"cwd": dir})
		if fr.T != "err" || fr.Error.Code != "TERMINAL_CWD_DENIED" {
			t.Fatalf("%q must be denied: %+v", dir, fr)
		}
	}
	if len(opened) != 1 || opened[0] != "/w/app" {
		t.Fatalf("opened = %v", opened)
	}
	r2 := contract.NewRouter()
	RegisterOpenTerminal(r2, check, func(string) error { return terminal.ErrNoTerminal })
	if fr := callAccounts(t, r2, "harness.openTerminal", map[string]any{"cwd": "/w/app"}); fr.T != "err" || fr.Error.Code != "TERMINAL_NOT_FOUND" {
		t.Fatalf("no terminal: %+v", fr)
	}
}
