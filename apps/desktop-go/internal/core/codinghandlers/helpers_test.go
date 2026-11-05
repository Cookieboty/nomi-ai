package codinghandlers

// 测试辅助

type nopLogger struct{}

func (nopLogger) Info(string, any) {}

func (nopLogger) Warn(string, any) {}

type nopPorts struct{}

func (nopPorts) PickDirectory(string, bool, string) *string { return nil }

func (nopPorts) AnyFocused() bool { return false }
