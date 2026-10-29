package tools

import "context"

// toolCaller.ts：工具调用发起方（编程助手标签）的异步上下文。
// Node 用 AsyncLocalStorage；Go 用 context 值。宿主以 RunWithToolCaller 包住工具执行。
type toolCallerKey struct{}

// RunWithToolCaller：runWithToolCaller(tabId, fn) —— 返回携带 tabId 的子 context
func RunWithToolCaller(ctx context.Context, tabID string) context.Context {
	return context.WithValue(ctx, toolCallerKey{}, tabID)
}

// GetToolCallerTabID：getToolCallerTabId()（未设置 → ok=false，对应 undefined）
func GetToolCallerTabID(ctx context.Context) (string, bool) {
	s, ok := ctx.Value(toolCallerKey{}).(string)
	return s, ok
}
