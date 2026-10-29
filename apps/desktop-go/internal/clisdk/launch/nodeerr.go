package launch

import "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodefs"

// uvDesc / errCode / nodeErrMessage 委托共享的 nodefs（Node libuv 错误码与文案）。
var uvDesc = nodefs.UvDesc

func errCode(err error) string { return nodefs.Code(err) }

func nodeErrMessage(err error, syscallName, path string, dest ...string) string {
	return nodefs.Message(err, syscallName, path, dest...)
}

// NodeErrMessage = nodeErrMessage（供其它包复刻 Node fs 同步错误文案）。
func NodeErrMessage(err error, syscallName, path string, dest ...string) string {
	return nodefs.Message(err, syscallName, path, dest...)
}
