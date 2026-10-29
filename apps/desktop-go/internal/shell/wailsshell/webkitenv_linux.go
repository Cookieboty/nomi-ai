//go:build linux

package wailsshell

import "os"

// WebKitGTK 2.4x 默认 DMA-BUF 渲染器：每个 WebKitWebProcess 额外常驻 ~55 MiB（GBM/EGL 缓冲 + 合成层），
// 透明小窗（看板娘 330×355）用不到。关掉后回退到共享内存渲染（Tauri/Wails 社区常用的兜底，亦修复部分
// NVIDIA/虚拟机下的白屏）。实测 Xvfb：WebProcess USS 71→17 MiB/个，页面加载 3.6s→0.6s（D-B11-13）。
// 用户显式设置了该变量则尊重用户。必须在 GTK/WebKit 初始化前生效 → 包 init。
func init() {
	if _, set := os.LookupEnv("WEBKIT_DISABLE_DMABUF_RENDERER"); !set {
		_ = os.Setenv("WEBKIT_DISABLE_DMABUF_RENDERER", "1")
	}
}
