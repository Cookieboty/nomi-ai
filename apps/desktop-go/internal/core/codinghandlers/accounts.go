package codinghandlers

import (
	"errors"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/accounts"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// Accounts = AccountService 的公开面（cliAccount.* 用到的部分）
type Accounts interface {
	List(kind string) ([]any, error)
	RefreshAll(kind string) *jsrt.Promise[[]any]
	SetDefault(kind, id string) (*util.Obj, error)
	Rename(id string, label any) (*util.Obj, error)
	Remove(id string, force bool) *jsrt.Promise[struct{}]
}

// AccountLogin = AccountLogin 的公开面
type AccountLogin interface {
	Start(kind string, accountID *string) *jsrt.Promise[*util.Obj]
	Input(id string, text any) bool
	Cancel(id string) bool
	OpenURL(raw string) (bool, error)
}

var (
	_ Accounts     = (*accounts.AccountService)(nil)
	_ AccountLogin = (*accounts.AccountLogin)(nil)
)

// AccountServices：getter 返回 nil（无类型）= 服务不可用
type AccountServices struct {
	Accounts func() Accounts
	Login    func() AccountLogin
}

// accountCodes = coding.ts 的 ACCOUNT_CODES（AccountError.code → 契约错误码）
var accountCodes = map[string]string{
	"not-found":    "ACCOUNT_NOT_FOUND",
	"in-use":       "ACCOUNT_IN_USE",
	"local":        "ACCOUNT_LOCAL",
	"unsupported":  "ACCOUNT_UNSUPPORTED",
	"unknown-live": "ACCOUNT_UNKNOWN_LIVE",
}

// accountCall = accountCall：AccountError 按契约错误码失败（ctx.fail），其余错误照常抛出
func accountCall(err error) {
	if err == nil {
		return
	}
	var ae *accounts.AccountError
	if errors.As(err, &ae) {
		if code, ok := accountCodes[ae.Code]; ok {
			panic(&contract.Error{Code: code, Message: ae.Message})
		}
	}
	var t jsrt.JSThrow
	if errors.As(err, &t) {
		panic(t)
	}
	panic(jsrt.JSThrow{Message: err.Error()})
}

func awaitAccount[T any](p *jsrt.Promise[T]) T {
	v, err := jsrt.Await(p)
	accountCall(err)
	return v
}

// accountKind = parseAccountKind（未知种类按普通异常抛出，与 Node 相同）
func accountKind(v any) string {
	k, err := accounts.ParseAccountKind(v)
	if err != nil {
		var t jsrt.JSThrow
		if errors.As(err, &t) {
			panic(t)
		}
		panic(jsrt.JSThrow{Message: err.Error()})
	}
	return k
}

// RegisterAccounts 挂上 cliAccount.*（= coding.ts 的 cliAccount 段）
func RegisterAccounts(r *contract.Router, s AccountServices) {
	acc := func() Accounts { return need(s.Accounts, "accounts") }
	login := func() AccountLogin { return need(s.Login, "accountLogin") }

	gil(r, "cliAccount.list", func(a in) any {
		kind := ""
		if k := a.any("kind"); util.Truthy(k) {
			kind = accountKind(k)
		}
		v, err := acc().List(kind)
		accountCall(err)
		return v
	})
	gil(r, "cliAccount.refresh", func(a in) any {
		return awaitAccount(acc().RefreshAll(accountKind(a.any("kind"))))
	})
	gil(r, "cliAccount.setDefault", func(a in) any {
		v, err := acc().SetDefault(accountKind(a.any("kind")), a.str("id"))
		accountCall(err)
		return v
	})
	gil(r, "cliAccount.rename", func(a in) any {
		v, err := acc().Rename(a.str("id"), a.any("label"))
		accountCall(err)
		return v
	})
	gil(r, "cliAccount.remove", func(a in) any {
		awaitAccount(acc().Remove(a.str("id"), a.is("force")))
		return nil
	})
	gil(r, "cliAccount.loginStart", func(a in) any {
		var id *string
		if s := a.str("accountId"); s != "" {
			id = &s
		}
		return awaitAccount(login().Start(accountKind(a.any("kind")), id))
	})
	gil(r, "cliAccount.loginInput", func(a in) any { return login().Input(a.str("id"), a.any("text")) })
	gil(r, "cliAccount.loginCancel", func(a in) any { return login().Cancel(a.str("id")) })
	gil(r, "cliAccount.openUrl", func(a in) any {
		ok, err := login().OpenURL(a.str("url"))
		throwIf(err)
		return ok
	})
}
