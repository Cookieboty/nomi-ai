package shell

// BrowserRegion：内置浏览器窗口要贴住的区域，单位是视图 CSS px（= 窗口 DIP），
// 相对对话窗口内容区左上角。宿主加上对话窗口在屏幕上的位置得到原生窗口的绝对坐标。
type BrowserRegion struct {
	X      int
	Y      int
	Width  int
	Height int
}

// BrowserEvents：浏览器窗口回报给核心的几件事（建窗成功后由外壳回调，可为 nil 字段）
type BrowserEvents struct {
	// Loaded：页面加载完成（每个页面各一次）；ok=false 时 message 说明原因（证书、DNS、拒绝连接）
	Loaded func(url string, ok bool, message string)
	// Closed：窗口没了（被系统关掉 / 应用退出）；核心据此让视图回到回退页
	Closed func()
}

// BrowserHost：内置浏览器窗口（对话旁标签区的「浏览器」标签）。
//
// 网页放在宿主的一个独立原生窗口里，是**顶层文档**：`X-Frame-Options` / `CSP frame-ancestors`
// 不参与判定，所以不会出现「已阻止此内容」那种错误页——iframe 里绕不过去这条（见
// docs/design/side-tabs-workspace.md）。外壳不实现这个接口（浏览器预览、无原生窗口的宿主）时，
// 视图拿 UNAVAILABLE，退到「在系统浏览器打开」。
type BrowserHost interface {
	// OpenBrowser：建窗口并加载 url，摆在 region 上；同一个 id 已经开着时换地址并重新贴位
	OpenBrowser(id, url string, region BrowserRegion, events BrowserEvents) error
	// SetBrowserRegion：更新区域；visible=false 时先藏起来（切标签、收面板、窗口最小化）
	SetBrowserRegion(id string, region BrowserRegion, visible bool)
	// NavigateBrowser：换地址（同一个地址等于刷新）
	NavigateBrowser(id, url string) error
	// ReloadBrowser：重新加载当前页（用户可能已经在窗口里点进别的页面了）
	ReloadBrowser(id string)
	// CloseBrowser：关掉并释放窗口
	CloseBrowser(id string)
}
