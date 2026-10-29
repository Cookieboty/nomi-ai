package accounts

import "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"

// HistoryAccountLabel = createCore.ts SessionHistoryService 的 accountLabel 依赖：
// 只有 Codex 的历史记录了 creator_account_id；找到账号 → identity?.email ?? label，否则 undefined（nil）。
func (s *AccountService) HistoryAccountLabel(backend, accountID string) (v any, err error) {
	if backend != "codex" {
		return nil, nil
	}
	a, err := s.FindByAccountID("codex", accountID)
	if err != nil || a == nil {
		return nil, err
	}
	return orElse(opt(a.Get("identity"), "email"), a.Get("label")), nil
}

// HistorySessionAccount = createCore.ts 的 sessionAccount 依赖：非账号 CLI → undefined；
// 只有一个账号时不标注（只回 { id }）。
func (s *AccountService) HistorySessionAccount(backend, sessionID string) (v *util.Obj, err error) {
	if !isKind(backend) {
		return nil, nil
	}
	a, err := s.SessionAccount(backend, sessionID)
	if err != nil || a == nil {
		return nil, err
	}
	l, err := s.List(backend)
	if err != nil {
		return nil, err
	}
	if len(l) > 1 {
		return a, nil
	}
	return util.NewObj("id", a.Get("id")), nil
}
