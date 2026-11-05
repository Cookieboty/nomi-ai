package tasks

// notify 执行者：到点发一条通知，通知本身就是结果。

type NotifyFunc func(title, text string)

type notifyExecutor struct{ notify NotifyFunc }

func NewNotifyExecutor(n NotifyFunc) Executor { return &notifyExecutor{notify: n} }

func (e *notifyExecutor) Prepare(t Task) (ExecutionSnapshot, *TaskError) {
	return ExecutionSnapshot{GrantVersion: t.Grant.Version}, nil
}

func (e *notifyExecutor) Start(ctx AttemptContext) {
	text := ctx.Task.Goal
	if ctx.Task.Executor.Kind == "notify" && ctx.Task.Executor.Text != nil {
		text = *ctx.Task.Executor.Text
	}
	defer func() {
		if p := recover(); p != nil {
			ctx.Report.Failed(TaskError{Code: "executor_failed", Message: "notify failed"})
		}
	}()
	e.notify(ctx.Task.Title, text)
	ctx.Report.Completed(AttemptResult{Summary: text, Artifacts: []Artifact{}})
}

func (e *notifyExecutor) Resume(string, int, Answer) {}
func (e *notifyExecutor) Stop(string, int, string)   {}
