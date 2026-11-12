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
	if r := ResolveModelMeta(u.NewObj("id", "Aerith-sonnet", "enabled", true), "Aerith-sonnet", nil, nil); r.Source != "default" || r.LongContext != nil || r.Ctx != DefaultCtx {
		t.Fatalf("unknown: %+v", r)
	}
	// 预设把完整窗口写成 1M、目录有通用标准档：生效窗口是标准档，不是 1M
	preset := u.NewObj("id", "deepseek-v4-pro", "ctx", 1_000_000.0, "ctxStandard", 262_144.0, "maxOutput", 393_216.0)
	stored := u.NewObj("id", "deepseek-v4-pro", "enabled", true, "ctx", 1_000_000.0, "maxOutput", 393_216.0, "metaSource", "preset")
	big := ResolveModelMeta(stored, "deepseek-v4-pro", preset, nil)
	if big.Ctx != 262_144 || big.LongContext == nil || big.LongContext.Full != 1_000_000 || big.LongContext.On || big.LongContext.Standard != 262_144 {
		t.Fatalf("preset 1M: %+v %+v", big, big.LongContext)
	}
	if r := ResolveModelMeta(stored, "deepseek-v4-pro", preset, &on); r.Ctx != 1_000_000 {
		t.Fatalf("preset long on: %v", r.Ctx)
	}
	// 已有标准档不被通用 256K 盖掉（GPT 272K）
	gpt := ResolveModelMeta(nil, "gpt-5.4", nil, nil)
	if gpt.LongContext == nil || gpt.LongContext.Standard != 272_000 || gpt.Ctx != 272_000 {
		t.Fatalf("gpt standard: %+v %+v", gpt, gpt.LongContext)
	}
	// 真实窗口不大于 256K：不拆标准档
	chat := ResolveModelMeta(nil, "deepseek-chat", nil, nil)
	if chat.LongContext != nil || chat.Ctx != 163_840 {
		t.Fatalf("deepseek-chat: %+v %+v", chat, chat.LongContext)
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
