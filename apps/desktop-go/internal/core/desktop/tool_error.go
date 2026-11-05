package desktop

// ToolError：带稳定 code 的工具错误
type ToolError struct {
	Code    string
	Message string
}

func (e *ToolError) Error() string { return e.Message }

func toolErr(code, msg string) *ToolError { return &ToolError{Code: code, Message: msg} }
