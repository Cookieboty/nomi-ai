package harness

const (
	MainTabID                    = "main"
	PermissionTimeoutMs          = 120_000
	DelegatedPermissionTimeoutMs = 600_000
	// TaskPermissionTimeoutMs：持续任务的标签，审批等任务收件箱里的回应
	TaskPermissionTimeoutMs = 7 * 86_400_000
)

// TabFinished = HarnessTabFinished（Error nil = 缺省）。
type TabFinished struct {
	TabID      string  `json:"tabId"`
	Title      string  `json:"title"`
	Backend    string  `json:"backend"`
	Ok         bool    `json:"ok"`
	Text       string  `json:"text"`
	Error      *string `json:"error,omitempty"`
	Background bool    `json:"background"`
	// DurationMs：这一轮用时（从这一轮的用户消息算起；找不到时 0）
	DurationMs float64 `json:"durationMs"`
	// Origin：谁发起的这一轮：user（用户自己发的）/ sandbox（沙箱授权后的「请继续」）/ ""（委派、任务等程序发的）
	Origin string `json:"origin,omitempty"`
}

// StoppedError = HarnessStoppedError（name = 'HarnessStoppedError'）。
type StoppedError struct {
	Msg         string
	PartialText string
}

func (e *StoppedError) Error() string { return e.Msg }
func (e *StoppedError) Name() string  { return "HarnessStoppedError" }
