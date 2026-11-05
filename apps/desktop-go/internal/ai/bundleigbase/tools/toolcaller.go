package tools

import "context"

// 工具调用发起方（编程助手标签）的异步上下文。
// 用 context 值传递；宿主以 RunWithToolCaller 包住工具执行。
type toolCallerKey struct{}

// RunWithToolCaller：runWithToolCaller(tabId, fn) —— 返回携带 tabId 的子 context
func RunWithToolCaller(ctx context.Context, tabID string) context.Context {
	return context.WithValue(ctx, toolCallerKey{}, tabID)
}

// GetToolCallerTabID：发起工具调用的标签 id（未设置 → ok=false）
func GetToolCallerTabID(ctx context.Context) (string, bool) {
	s, ok := ctx.Value(toolCallerKey{}).(string)
	return s, ok
}
