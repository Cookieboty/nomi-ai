package main

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/chatassets"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/harness"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/gwstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/media"

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
	kb *knowledge.Service, mem *memory.Service, ext *extensions.Service, d *desktop.Service,
	image igtools.ImageDeps) {
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
	// 生图（image_generate，没设置图片模型时不提供给模型）：与 Node plugin.ts 同位（delegate 之后、ext 之前）
	defs = append(defs, igtools.ImageTools(image)...)
	defs = append(defs, igtools.SkillTools(ext)...)
	// 记忆检索、技能说明与参考文件都是外部内容：本轮标为读过外部内容（Node plugin.ts markExternalReads）
	if d != nil && d.Broker != nil {
		defs = markExternalReads(defs, d.Broker.MarkRead)
	}
	// 按需提供：对话里没提到的工具组（提醒、浏览器、文件…）不发给模型（Node plugin.ts applyToolGates）
	for _, def := range defs {
		r.Register(igtools.WithGate(def))
	}
}

// externalReadTools：输出来自用户以外来源（过往对话摘要、第三方技能包）的工具。kb_search、文件 / 浏览器工具
// 自己在工具体里标记；MCP 工具在 extensions.withConfirm 里标记。
var externalReadTools = map[string]bool{"memory_search": true, "skill_load": true, "skill_read_file": true}

// markExternalReads：这些工具成功返回后把本轮标为读过外部内容（命令自动审核据此不放行中风险命令）
func markExternalReads(defs []tools.Definition, mark func(context.Context)) []tools.Definition {
	for i, def := range defs {
		if !externalReadTools[def.Name] || def.Execute == nil {
			continue
		}
		inner := def.Execute
		defs[i].Execute = func(ctx context.Context, in any, ec tools.ExecContext) (any, error) {
			out, err := inner(ctx, in, ec)
			if err == nil {
				mark(ctx)
			}
			return out, err
		}
	}
	return defs
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

// imageToolDeps：生图工具读网关里 Nomi 的图片模型与供应商信息（gwstore.Service.NomiImageRef / ImageProvider）
func imageToolDeps(gw *gwstore.Service, imagesDir string, lib *chatassets.Library) igtools.ImageDeps {
	return igtools.ImageDeps{
		ImageAuto: func() bool { return gw != nil && gw.NomiImageAuto() },
		OnGenerated: func(file string, m igtools.GeneratedMeta) {
			if lib != nil {
				lib.Record(file, chatassets.Meta{Model: m.Model, Prompt: m.Prompt, Aspect: m.Aspect,
					EditedFrom: m.EditedFrom, References: m.References, ConversationID: m.ConversationID})
			}
		},
		ImageRef: func() string {
			if gw == nil {
				return ""
			}
			return gw.NomiImageRef()
		},
		ImageProvider: func(id string) *igtools.ImageAccess {
			if gw == nil {
				return nil
			}
			a := gw.ImageProvider(id)
			if a == nil {
				return nil
			}
			return &igtools.ImageAccess{
				Info:    media.ProviderInfo{ID: id, PresetID: a.PresetID, URLs: a.URLs, Auth: a.Auth},
				KeyFor:  a.KeyFor,
				Headers: a.Headers,
			}
		},
		ImagesDir: imagesDir,
	}
}
