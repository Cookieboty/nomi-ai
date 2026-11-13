package codinghandlers

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/accounts"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

type fakeAccounts struct {
	listKind string
	removed  []accounts.RemoveOpts
}

func (f *fakeAccounts) List(kind string) ([]any, error) {
	f.listKind = kind
	return []any{map[string]any{"id": "a1", "kind": "claude"}}, nil
}
func (f *fakeAccounts) RefreshAll(string) *jsrt.Promise[[]any] {
	return jsrt.Async(func() ([]any, error) { return []any{}, nil })
}
func (f *fakeAccounts) SetDefault(_, id string) (*util.Obj, error) {
	return nil, &accounts.AccountError{Code: "not-found", Message: "no " + id}
}
func (f *fakeAccounts) Rename(string, any) (*util.Obj, error) { return nil, nil }
func (f *fakeAccounts) Remove(id string, force bool) *jsrt.Promise[struct{}] {
	return f.RemoveWith(id, accounts.RemoveOpts{Force: force})
}
func (f *fakeAccounts) RemoveWith(id string, o accounts.RemoveOpts) *jsrt.Promise[struct{}] {
	f.removed = append(f.removed, o)
	return jsrt.Async(func() (struct{}, error) {
		if id == "ext" && !o.StopExternal {
			return struct{}{}, &accounts.AccountError{Code: "external-busy", Message: "2 outside", Pids: []float64{26348, 26351}}
		}
		if id == "ext" {
			return struct{}{}, nil
		}
		return struct{}{}, &accounts.AccountError{Code: "in-use", Message: "busy"}
	})
}

type fakeLogin struct{ cancelled *[]string }

func (fakeLogin) Start(string, *string) *jsrt.Promise[*util.Obj] {
	return jsrt.Async(func() (*util.Obj, error) { return nil, nil })
}
func (fakeLogin) Input(string, any) bool { return true }
func (l fakeLogin) Cancel(id string) bool {
	if l.cancelled != nil {
		*l.cancelled = append(*l.cancelled, id)
	}
	return false
}
func (fakeLogin) OpenURL(string) (bool, error) { return false, nil }

func callAccounts(t *testing.T, r *contract.Router, name string, input any) contract.ServerFrame {
	t.Helper()
	ch := make(chan contract.ServerFrame, 1)
	s := r.NewSession(context.Background(), contract.Caller{Surface: "chat"}, func(fr contract.ServerFrame) { ch <- fr })
	defer s.Close()
	in, _ := json.Marshal(input)
	b, _ := json.Marshal(contract.ClientFrame{T: "req", ID: "1", Kind: "call", Name: name, Input: in})
	s.Handle(b)
	return <-ch
}

func TestCliAccountHandlers(t *testing.T) {
	f := &fakeAccounts{}
	cancelled := []string{}
	r := contract.NewRouter()
	RegisterAccounts(r, AccountServices{
		Accounts: func() Accounts { return f },
		Login:    func() AccountLogin { return fakeLogin{cancelled: &cancelled} },
	})

	// kind 缺省 = 全部
	if fr := callAccounts(t, r, "cliAccount.list", map[string]any{}); fr.T != "res" || f.listKind != "" {
		t.Fatalf("list all: %+v kind=%q", fr, f.listKind)
	}
	if fr := callAccounts(t, r, "cliAccount.list", map[string]any{"kind": "codex"}); fr.T != "res" || f.listKind != "codex" {
		t.Fatalf("list codex: %+v kind=%q", fr, f.listKind)
	}
	// 未知种类：普通异常（不是 ACCOUNT_*）
	if fr := callAccounts(t, r, "cliAccount.list", map[string]any{"kind": "nope"}); fr.T != "err" || fr.Error.Code == "ACCOUNT_NOT_FOUND" {
		t.Fatalf("unknown kind: %+v", fr)
	}
	// AccountError → 契约错误码（同步与 Promise 两条路）
	if fr := callAccounts(t, r, "cliAccount.setDefault", map[string]any{"kind": "claude", "id": "x"}); fr.T != "err" || fr.Error.Code != "ACCOUNT_NOT_FOUND" || fr.Error.Message != "no x" {
		t.Fatalf("setDefault: %+v", fr.Error)
	}
	if fr := callAccounts(t, r, "cliAccount.remove", map[string]any{"id": "x"}); fr.T != "err" || fr.Error.Code != "ACCOUNT_IN_USE" {
		t.Fatalf("remove: %+v", fr.Error)
	}
	// 删除前先取消这个账号还开着的登录（登录用的 CLI 不再挡着删除）
	if len(cancelled) != 1 || cancelled[0] != "x" {
		t.Fatalf("remove should cancel the account's pending login first: %v", cancelled)
	}
	// Nomi 之外的进程：单独的错误码，带上进程号；确认后 stopExternal 透传
	fr := callAccounts(t, r, "cliAccount.remove", map[string]any{"id": "ext"})
	if fr.T != "err" || fr.Error.Code != "ACCOUNT_EXTERNAL_BUSY" {
		t.Fatalf("external busy: %+v", fr.Error)
	}
	if b, _ := json.Marshal(fr.Error.Data); string(b) != `{"pids":[26348,26351]}` {
		t.Fatalf("external busy data: %s", b)
	}
	if fr := callAccounts(t, r, "cliAccount.remove", map[string]any{"id": "ext", "stopExternal": true}); fr.T != "res" {
		t.Fatalf("remove with stopExternal: %+v", fr)
	}
	if last := f.removed[len(f.removed)-1]; !last.StopExternal || last.Force {
		t.Fatalf("opts=%+v", last)
	}
	if fr := callAccounts(t, r, "cliAccount.loginInput", map[string]any{"id": "s", "text": "code"}); fr.T != "res" || fr.Output != true {
		t.Fatalf("loginInput: %+v", fr)
	}

	// 服务不可用
	r2 := contract.NewRouter()
	RegisterAccounts(r2, AccountServices{})
	if fr := callAccounts(t, r2, "cliAccount.list", map[string]any{}); fr.T != "err" || fr.Error.Code != "UNAVAILABLE" {
		t.Fatalf("unavailable: %+v", fr)
	}
}
