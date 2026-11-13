package delegate

// 派出去的编程助手要用用户在设置里给这个 CLI 预选的模型。
// 以前委派只带 profile / 显式 model，没配就落到 CLI 自己的默认模型，用户看起来就是
// 「我预选了模型，派出去的 agent 却没按它跑」。

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

type fakeGateway struct{ d *util.Obj }

func (g fakeGateway) Defaults(string) *util.Obj { return g.d }
func (g fakeGateway) Models() []*util.Obj       { return nil }

func TestPreselectedModelInheritsOfficialChoice(t *testing.T) {
	svc := &Service{d: Deps{Gateway: fakeGateway{d: util.NewObj(
		"source", "official", "model", "claude-opus-4-1", "accountId", "acc_1")}}}
	if got := svc.preselectedModel("claude"); got != "claude-opus-4-1" {
		t.Fatalf("got %q", got)
	}
}

func TestPreselectedModelSkipsThirdPartyRef(t *testing.T) {
	// 第三方来源的模型是网关 ref（带 /），标签自己按来源解，不能当 CLI 模型名传
	svc := &Service{d: Deps{Gateway: fakeGateway{d: util.NewObj(
		"source", "thirdParty", "model", "deep/ds-v4")}}}
	if got := svc.preselectedModel("claude"); got != "" {
		t.Fatalf("got %q", got)
	}
}

func TestPreselectedModelSkipsGarbageAndMissingGateway(t *testing.T) {
	svc := &Service{d: Deps{Gateway: fakeGateway{d: util.NewObj("source", "official", "model", "  ")}}}
	if got := svc.preselectedModel("claude"); got != "" {
		t.Fatalf("got %q", got)
	}
	none := &Service{}
	if got := none.preselectedModel("claude"); got != "" {
		t.Fatalf("got %q", got)
	}
}
