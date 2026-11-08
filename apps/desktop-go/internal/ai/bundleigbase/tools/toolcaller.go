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

// 发起工具调用的 Nomi 对话（权限按对话记授权用）。只加值、不换取消信号，
// 所以按 ctx.Done() 记的「本轮读过外部内容」不受影响。
type conversationKey struct{}

// WithConversation：返回携带对话 id 的子 context（id 为空时原样返回）
func WithConversation(ctx context.Context, id string) context.Context {
	if id == "" || ctx == nil {
		return ctx
	}
	return context.WithValue(ctx, conversationKey{}, id)
}

// ConversationFrom：发起工具调用的对话 id（没有 → ""）
func ConversationFrom(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	s, _ := ctx.Value(conversationKey{}).(string)
	return s
}
