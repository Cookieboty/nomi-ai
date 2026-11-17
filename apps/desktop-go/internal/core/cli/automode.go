package cli

// automode.go：「自动」档在这个端点 + 模型上到底能不能用，靠运行时学，不靠模型名猜。
//
// Claude 的 auto 模式由**服务端**分类器判断每个动作要不要确认（beta auto-mode-classifier-*，
// 走同一个 base URL 的附带请求）。它能不能跑，取决于对端是否提供该能力、以及是否把这个
// 附带请求透传过去 —— 跟模型叫什么名字无关，换一个供应商、同一个模型换个名字都可能不一样。
// 所以这里只记录「实测跑不通」，键是端点 + 模型；下次启动同一个组合就直接用降级档，
// 不必再让用户白白等一轮。

import (
	"os"
	"path/filepath"
	"sync"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const autoModeFile = "auto-mode-support.json"

// AutoModeTable：端点+模型 → 学到的原因（unsupported：auto 在这里用不了）。
type AutoModeTable struct {
	mu   sync.Mutex
	root string
	warn func(msg string, err error)
	m    map[string]string
}

func NewAutoModeTable(root string, warn func(string, error)) *AutoModeTable {
	if warn == nil {
		warn = func(string, error) {}
	}
	return &AutoModeTable{root: root, warn: warn}
}

// Key：端点（host）+ 模型。official 表示官方登录（没有 base URL 覆盖）。
func AutoModeKey(endpoint, model string) string {
	ep := util.JSTrim(endpoint)
	if ep == "" {
		ep = "official"
	}
	m := util.JSTrim(model)
	if m == "" {
		m = "default"
	}
	return ep + "|" + m
}

func (t *AutoModeTable) load() {
	if t.m != nil {
		return
	}
	t.m = map[string]string{}
	b, err := os.ReadFile(filepath.Join(t.root, autoModeFile))
	if err != nil {
		return
	}
	v, err := util.ParseString(string(b))
	if err != nil {
		return
	}
	o, ok := v.(*util.Obj)
	if !ok {
		return
	}
	if entries, ok := o.Get("unsupported").(*util.Obj); ok {
		for _, k := range entries.Keys() {
			if s := util.Str(entries.Get(k)); s != "" {
				t.m[k] = s
			}
		}
	}
}

// Unsupported：这个端点+模型上学到过 auto 用不了（"" = 没学到，照常下发）。
func (t *AutoModeTable) Unsupported(key string) string {
	if t == nil || key == "" {
		return ""
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.load()
	return t.m[key]
}

// NoteUnsupported：记下这个端点+模型上 auto 跑不通（同键只写一次）。
func (t *AutoModeTable) NoteUnsupported(key, reason string) {
	if t == nil || key == "" {
		return
	}
	t.mu.Lock()
	t.load()
	if _, ok := t.m[key]; ok {
		t.mu.Unlock()
		return
	}
	t.m[key] = reason
	entries := util.NewObj()
	for k, v := range t.m {
		entries.Set(k, v)
	}
	data := util.Stringify(util.NewObj("version", 1.0, "unsupported", entries))
	t.mu.Unlock()
	if err := utils.WritePrivateFileAtomic(filepath.Join(t.root, autoModeFile), []byte(data)); err != nil {
		t.warn("auto-mode-support write failed", err)
	}
}
