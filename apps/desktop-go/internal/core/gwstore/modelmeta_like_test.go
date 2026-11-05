package gwstore

import (
	"testing"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// like 按已知模型查；ctxStandard 让任何模型有长上下文可开
func TestResolveModelMetaLikeAndStandard(t *testing.T) {
	on := true
	like := u.NewObj("id", "Aerith-sonnet", "enabled", true, "like", "claude-sonnet-4.6")
	r := ResolveModelMeta(like, "Aerith-sonnet", nil, nil)
	if r.LongContext == nil || r.LongContext.Standard != 200_000 || r.LongContext.Full != 1_000_000 || r.Ctx != 200_000 || r.MaxOutput != 128_000 {
		t.Fatalf("like: %+v %+v", r, r.LongContext)
	}
	if r := ResolveModelMeta(like, "Aerith-sonnet", nil, &on); r.Ctx != 1_000_000 {
		t.Fatalf("like long on: %v", r.Ctx)
	}
	if r := ResolveModelMeta(u.NewObj("id", "Aerith-sonnet", "enabled", true), "Aerith-sonnet", nil, nil); r.Source != "default" || r.LongContext != nil {
		t.Fatalf("unknown: %+v", r)
	}
	m := u.NewObj("id", "private-model", "enabled", true, "ctx", 2_000_000.0, "ctxStandard", 256_000.0, "metaSource", "user")
	off := ResolveModelMeta(m, "private-model", nil, nil)
	if off.LongContext == nil || off.LongContext.Standard != 256_000 || off.Ctx != 256_000 || off.Source != "user" {
		t.Fatalf("ctxStandard off: %+v %+v", off, off.LongContext)
	}
	if r := ResolveModelMeta(m, "private-model", nil, &on); r.Ctx != 2_000_000 {
		t.Fatalf("ctxStandard on: %v", r.Ctx)
	}
	plain := u.NewObj("id", "private-model", "enabled", true, "ctx", 2_000_000.0, "metaSource", "user")
	if r := ResolveModelMeta(plain, "private-model", nil, nil); r.Ctx != 2_000_000 || r.LongContext != nil {
		t.Fatalf("plain user ctx: %+v", r)
	}
}
