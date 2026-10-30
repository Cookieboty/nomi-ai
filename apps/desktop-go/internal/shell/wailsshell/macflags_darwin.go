//go:build darwin && !private_mac_apis

package wailsshell

// 桌面角色 / 灵动岛窗口的透明依赖 Wails 的 private_mac_apis（WKWebView drawsBackground=NO）。
// 不带这个 tag 编出来的 Mac 包是白底，所以直接让编译失败：go build -tags private_mac_apis。
var _ = macBuildsRequireTagPrivateMacAPIs
