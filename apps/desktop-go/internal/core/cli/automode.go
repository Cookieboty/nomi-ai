package cli

// automode.go：「自动」档在这个端点 + 模型上到底能不能用，靠运行时学，不靠模型名猜。
//
// Claude 的 auto 判定随每次 /v1/messages 带 safeguards + beta dangerous-tool-use-*，
// 结果回到响应的 safeguard_results —— 只要网关原样转运就能用，所以「端点不支持」本来
// 就不是常态（Nomi 自己的网关一直这么转）。真正会让它停摆的是 CLI 侧的 auto 前置状态
// 缺失，那由 accounts.EnsureAccountHome 补齐；这里只兜真正跑不通的情况：按端点 + 模型
// 记下实测结果，下次启动同一组合直接走降级档，不必再让用户白白等一轮。

import (
	"os"
	"path/filepath"
	"sync"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const autoModeFile = "auto-mode-support.json"

// autoModeTableVersion：表格式版本。根因弄错（把「配置缺状态」当成「端点不支持」）那代的
// 记录一律作废，否则升级后还会把用户按在降级档上。
const autoModeTableVersion = 2.0

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
	if ver, ok := o.Get("version").(float64); !ok || ver != autoModeTableVersion {
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
	data := util.Stringify(util.NewObj("version", autoModeTableVersion, "unsupported", entries))
	t.mu.Unlock()
	if err := utils.WritePrivateFileAtomic(filepath.Join(t.root, autoModeFile), []byte(data)); err != nil {
		t.warn("auto-mode-support write failed", err)
	}
}
