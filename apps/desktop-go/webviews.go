package main

import (
	"errors"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"

	"github.com/zalando/go-keyring"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
)

// webViewsEnv：截图脚本 / CI 用的开关（scripts/site-screenshots/go-app.mjs）。和 NOMI_POC_CTL 一起设置时，
// 应用窗口里的视图资源（同一条中间件链，含 /__scheme/ 资源网关）也在这个回环地址上提供，内核接受它作为
// WebSocket 来源；控制口的 `op=web-url&surface=chat|mascot` 给出带本次 token 的页面地址，供外部浏览器打开。
const webViewsEnv = "NOMI_WEB_VIEWS"

type webViews struct {
	ln     net.Listener
	origin string // http://127.0.0.1:<端口>
}

// listenWebViews：没设 NOMI_POC_CTL 或 NOMI_WEB_VIEWS 时返回 nil；地址只认回环
func listenWebViews(ctl string) *webViews {
	addr := os.Getenv(webViewsEnv)
	if ctl == "" || addr == "" {
		return nil
	}
	host, _, err := net.SplitHostPort(addr)
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		log.Printf("[web-views] %s must be a loopback host:port, got %q", webViewsEnv, addr)
		return nil
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Printf("[web-views] listen %s: %v", addr, err)
		return nil
	}
	v := &webViews{ln: ln, origin: "http://" + ln.Addr().String()}
	log.Printf("[web-views] serving views at %s", v.origin)
	return v
}

func (v *webViews) serve(h http.Handler) {
	go func() {
		if err := http.Serve(v.ln, h); err != nil {
			log.Printf("[web-views] %v", err)
		}
	}()
}

// pageURL：给 surface 发一个 token（随进程存活），返回视图页地址；片段格式与应用窗口相同（ws / token / ctl）
func (v *webViews) pageURL(ws *contract.WSServer, surface, ctl string) (string, error) {
	if v == nil {
		return "", errors.New(webViewsEnv + " is not set")
	}
	var page string
	switch surface {
	case "chat":
		page = "/chat/index.html"
	case "mascot":
		page = "/mascot/index.html"
	default:
		return "", errors.New("surface must be chat or mascot")
	}
	token, _ := ws.Issue(surface)
	frag := url.Values{}
	frag.Set("ctl", ctl)
	frag.Set("ws", ws.URL)
	frag.Set("token", token)
	return v.origin + page + "#" + frag.Encode(), nil
}

// useMemoryKeyringForTests：截图脚本 / CI 在隔离的 HOME 里跑，没有登录钥匙串（macOS 上写钥匙串会卡住）。
// 同时设了 NOMI_POC_CTL 与 NOMI_TEST_MEMORY_KEYRING=1 时，机密改存进程内存（退出即丢）。
func useMemoryKeyringForTests() {
	if os.Getenv("NOMI_POC_CTL") != "" && os.Getenv("NOMI_TEST_MEMORY_KEYRING") == "1" {
		keyring.MockInit()
		log.Printf("[test] secrets are kept in memory (NOMI_TEST_MEMORY_KEYRING)")
	}
}
