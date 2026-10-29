package harness

const (
	MainTabID                    = "main"
	PermissionTimeoutMs          = 120_000
	DelegatedPermissionTimeoutMs = 600_000
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
}

// StoppedError = HarnessStoppedError（name = 'HarnessStoppedError'）。
type StoppedError struct {
	Msg         string
	PartialText string
}

func (e *StoppedError) Error() string { return e.Msg }
func (e *StoppedError) Name() string  { return "HarnessStoppedError" }
