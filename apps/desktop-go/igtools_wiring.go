package main

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/harness"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/runtime/aifacade"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/runtime/igtools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/extensions"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/knowledge"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/memory"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// kbHost：KnowledgeService.tools() 的 this（d.desktop = DesktopService）
type kbHost struct {
	kb *knowledge.Service
	d  *desktop.Service
}

func (h kbHost) CheckSend(ctx context.Context, p *tools.ToolCallProvider) string {
	return h.d.CheckSendAll(delegateDesktop{s: h.d}.ReceiversFor(p, []string{"chat", "agent-tools"}), ctx, "")
}

func (h kbHost) Search(ctx context.Context, q string, limit int) ([]igtools.KBHit, string) {
	r := h.kb.Search(ctx, q, limit)
	out := make([]igtools.KBHit, len(r.Hits))
	for i, x := range r.Hits {
		out[i] = igtools.KBHit{Title: x.Title, Path: x.Path, Text: x.Text}
		if x.Page != 0 { // Hit.page 为 1 起的页码；0 = 无页码（undefined）
			p := float64(x.Page)
			out[i].Page = &p
		}
	}
	return out, r.Mode
}

func (h kbHost) MarkRead(ctx context.Context) { h.d.Broker.MarkRead(ctx) }

func (h kbHost) Audit(query string) {
	h.d.Audit.Append(desktop.AuditEntry{Tool: "kb_search", Decision: "auto", Result: "ok", Source: "agent"},
		json.RawMessage(util.Stringify(util.NewObj("query", query))))
}

// memHost：MemoryService.tools() 的 this
type memHost struct{ m *memory.Service }

func (h memHost) Enabled() bool                                 { return h.m.Settings().Enabled }
func (h memHost) Context(ctx context.Context, q string) string  { return h.m.Context(ctx, q).Text }
func (h memHost) Audit(tool string, args *util.Obj, res string) { h.m.ToolAudit(tool, args, res) }
func (h memHost) HasDuplicate(text string) bool                 { return h.m.HasDuplicateFact(text) }
func (h memHost) Gesture(name string)                           { h.m.Gesture(name) }
func (h memHost) UpsertFact(ctx context.Context, text, kind string) (string, error) {
	f, err := h.m.UpsertFact(ctx, map[string]any{"text": text, "kind": kind})
	return f.ID, err
}

var _ igtools.SkillHost = (*extensions.Service)(nil)

// lazyAvatar：AIClient 门面在工具注册之后创建（avatar 种子同一个 AvatarService）
type lazyAvatar struct{ f **aifacade.Facade }

func (a lazyAvatar) AvatarGesture(n string) error {
	if *a.f == nil {
		return errAvatarNotReady
	}
	return (*a.f).AvatarGesture(n)
}

func (a lazyAvatar) AvatarEmotion(n string, w *float64) error {
	if *a.f == nil {
		return errAvatarNotReady
	}
	return (*a.f).AvatarEmotion(n, w)
}

var errAvatarNotReady = errors.New("avatar not ready")

// delegateToolNames：DelegateService.tools() 在 wireCoding 里才构造；先占位保住 Map 插入顺序（kb → mem → delegate → ext）
var delegateToolNames = []string{"delegate_to_cli", "delegate_status", "delegate_followup"}

// registerIgTools = createIgPluginHost 的插件顺序：ToolsBuiltin → UserPreferenceMemory → CompanionTools → DesktopTools
func registerIgTools(r tools.Registry, profile *aifacade.ProfileStore, fac **aifacade.Facade,
	kb *knowledge.Service, mem *memory.Service, ext *extensions.Service, d *desktop.Service) {
	defs := igtools.BuiltinTools(igtools.Env{})
	defs = append(defs, igtools.PreferenceTools(profile, igtools.Env{})...)
	defs = append(defs, igtools.CompanionTools(lazyAvatar{fac}, true)...)
	if d != nil {
		defs = append(defs, igtools.DesktopTools(igtools.DeskDepsFor(d, desktopShellEnv))...)
	}
	defs = append(defs, igtools.KBTools(kbHost{kb: kb, d: d})...)
	defs = append(defs, igtools.MemTools(memHost{m: mem})...)
	for _, n := range delegateToolNames {
		defs = append(defs, tools.Definition{Name: n, DangerousUnset: true,
			Execute: func(context.Context, any, tools.ExecContext) (any, error) {
				return nil, errors.New("delegate not ready")
			}})
	}
	defs = append(defs, igtools.SkillTools(ext)...)
	for _, def := range defs {
		r.Register(def)
	}
}

// desktopShellEnv = cliChildEnv(false)：工作区命令与编程助手标签同一套环境
func desktopShellEnv() []string {
	o := harness.CliChildEnv(false, nil)
	var env []string
	for _, k := range o.Keys() {
		if v, ok := o.Get(k).(string); ok {
			env = append(env, k+"="+v)
		}
	}
	return env
}
