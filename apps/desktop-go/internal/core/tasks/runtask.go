package tasks

import "context"

type runTaskKey struct{}

// WithRunTask：把正在执行的任务 id 登记到 ctx 上（Nomi 后台运行里委派出去的编程助手据此记下「是谁派的」，
// Agent 看板显示调度树）
func WithRunTask(ctx context.Context, taskID string) context.Context {
	if ctx == nil || taskID == "" {
		return ctx
	}
	return context.WithValue(ctx, runTaskKey{}, taskID)
}

// RunTaskFrom：ctx 所在的任务执行（没有 = 不是后台执行）
func RunTaskFrom(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	id, _ := ctx.Value(runTaskKey{}).(string)
	return id
}
