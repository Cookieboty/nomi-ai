package desktop

// ToolError：带稳定 code 的工具错误
type ToolError struct {
	Code    string
	Message string
}

func (e *ToolError) Error() string { return e.Message }

// ToolErrorCode：错误码（aisdk 据此判断是不是用户拒绝，决定要不要自动续跑）
func (e *ToolError) ToolErrorCode() string { return e.Code }

func toolErr(code, msg string) *ToolError { return &ToolError{Code: code, Message: msg} }
