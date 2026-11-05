package launch

import "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodefs"

// uvDesc / errCode / nodeErrMessage 委托共享的 nodefs（libuv 错误码与 Node 风格文案）。
var uvDesc = nodefs.UvDesc

func errCode(err error) string { return nodefs.Code(err) }

func nodeErrMessage(err error, syscallName, path string, dest ...string) string {
	return nodefs.Message(err, syscallName, path, dest...)
}

// NodeErrMessage：fs 同步调用的 Node 风格错误文案（供其它包使用）。
func NodeErrMessage(err error, syscallName, path string, dest ...string) string {
	return nodefs.Message(err, syscallName, path, dest...)
}
