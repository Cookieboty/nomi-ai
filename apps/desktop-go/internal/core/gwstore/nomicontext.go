package gwstore

import (
	"math"
	"strings"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Nomi 对话的上下文预算（按路由到的模型的窗口算）

const (
	// CompactRatio：自动压缩阈值（输入预算的比例）
	CompactRatio     = 0.95
	maxOutputReserve = 32_000
	// NomiMaxMessages：每轮最多带的历史条数（只防极端情况；主要按 token 预算裁）
	NomiMaxMessages = 1000
)

// 用户上下文档位（设置里的硬上限）。0 = 不额外封顶，按模型标准窗口 / 长上下文。
const (
	ContextTier128k = 128_000
	ContextTier200k = 200_000
	ContextTier256k = DefaultCtx
)

// AllowedContextTier：设置里可选的档位。0 表示「跟模型」（不额外封顶）。
func AllowedContextTier(n float64) bool {
	return n == ContextTier128k || n == ContextTier200k || n == ContextTier256k
}

// ApplyContextTier：有效窗口 = min(模型生效窗口, 用户档位)。档位无效或为 0 时不封顶。
func ApplyContextTier(window, tier float64) float64 {
	if AllowedContextTier(tier) && tier > 0 && tier < window {
		return tier
	}
	return window
}

// NomiContextBudget = nomiContextBudget({ ctx, maxOutput })：window / outputReserve / budget / compactAt
func NomiContextBudget(ctx, maxOutput float64) (window, outputReserve, budget, compactAt float64) {
	window = math.Max(1, math.Floor(ctx))
	mo := maxOutput
	if mo == 0 || math.IsNaN(mo) {
		mo = maxOutputReserve
	}
	outputReserve = math.Max(0, math.Min(math.Min(mo, maxOutputReserve), math.Floor(window/4)))
	budget = window - outputReserve
	return window, outputReserve, budget, math.Floor(budget * CompactRatio)
}

// ContextTier：用户设的上下文档位；0 = 不额外封顶。
func (s *Service) ContextTier() float64 {
	if s == nil || s.Store == nil {
		return 0
	}
	f, _ := s.Store.View().Snapshot().Get("contextTier").(float64)
	if !AllowedContextTier(f) {
		return 0
	}
	return f
}

// NomiContext = GatewayService.nomiContext(role)：没配模型时 nil
func (s *Service) NomiContext(role string) *u.Obj {
	picked := s.nomiPick(role)
	if picked == nil {
		return nil
	}
	ctx, maxOut, src := float64(DefaultCtx), float64(DefaultMaxOutput), "default"
	if m := s.ModelMetaOf(picked.PublicModel, nil); m != nil {
		ctx, maxOut, src = m.Ctx, m.MaxOutput, m.Source
	}
	ctx = ApplyContextTier(ctx, s.ContextTier())
	w, r, b, c := NomiContextBudget(ctx, maxOut)
	return u.NewObj("model", picked.PublicModel, "window", w, "outputReserve", r, "budget", b, "compactAt", c, "source", src)
}

// ChatRoleOf = chatRoleOf(role, method)
func ChatRoleOf(role any, method string) string {
	if r, ok := role.(string); ok && (r == "chat" || r == "agent-tools" || r == "summary") {
		return r
	}
	if strings.HasPrefix(method, "agent") {
		return "agent-tools"
	}
	return "chat"
}

// ApplyNomiContext = applyNomiContext(options, method, contextOf)：没带预算、也没指定 provider 时就地写入
func ApplyNomiContext(options map[string]any, method string, contextOf func(role string) *u.Obj) {
	if _, ok := options["context"]; ok {
		return
	}
	if p, ok := options["provider"]; ok && u.Truthy(p) {
		return
	}
	info := contextOf(ChatRoleOf(options["role"], method))
	if info == nil {
		return
	}
	options["context"] = map[string]any{"maxTokens": info.Get("budget"), "maxMessages": float64(NomiMaxMessages)}
}
