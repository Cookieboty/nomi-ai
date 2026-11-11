package tasks

// 任务错误码。只有瞬时错误可重试。
var errorRetryable = map[string]bool{
	"upstream_transient":  true,
	"network":             true,
	"executor_crashed":    true,
	"timed_out":           false,
	"executor_failed":     false,
	"config_changed":      false,
	"grant_denied":        false,
	"reconcile_abandoned": false,
	"prepare_failed":      false,
}

// errorAsks：要人处理的错误（配置变了）：执行失败后任务停到「等你处理」，用户确认后重跑，不悄悄换配置
var errorAsks = map[string]bool{"config_changed": true}

// AsksUser：这个错误码是否要停下来问用户
func AsksUser(code string) bool { return errorAsks[code] }

// IsRetryable：未知错误码按不可重试处理
func IsRetryable(code string) bool { return errorRetryable[code] }

// DefaultMaxRetries：瞬时错误最多重试次数（Budget.MaxRetries 默认值）
const DefaultMaxRetries = 3

// AutoPauseAfterFailures：重复任务连续失败多少次自动暂停
const AutoPauseAfterFailures = 3

// RetryBackoffMs：2 秒起翻倍，封顶 60 秒；attempt 从 1 开始
func RetryBackoffMs(attempt int) int64 {
	if attempt < 1 {
		attempt = 1
	}
	ms := int64(2000)
	for i := 1; i < attempt && ms < 60_000; i++ {
		ms *= 2
	}
	if ms > 60_000 {
		ms = 60_000
	}
	return ms
}
