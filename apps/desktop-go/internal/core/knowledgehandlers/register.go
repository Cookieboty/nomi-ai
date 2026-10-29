// Package knowledgehandlers 把批次 8（知识库 / 记忆 / 定时 / 本地模型 / 导出 / 扩展）的 77 个契约过程
// 挂到 Router；对应 packages/core/src/contract/knowledge.ts。
package knowledgehandlers

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/extensions"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/knowledge"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/local"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/memory"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/schedule"
)

// Declared：APP_DOMAINS.knowledge.errors
var Declared = map[string]bool{
	"KB_DENIED": true, "KB_EMPTY": true, "KB_LOCAL_ONLY": true, "KB_USER_DENIED": true, "KB_OCR_MISSING": true,
	"MEM_BAD_SUMMARY": true, "MEM_SUMMARIZE_FAILED": true, "MEM_NOT_FOUND": true, "MEM_EMPTY": true,
	"SCHED_INVALID": true, "SCHED_NOT_FOUND": true, "SCHED_BUSY": true, "SCHED_EMPTY": true,
}

// ErrorCode：knowledgeErrorCode(prefix, err)；没声明的返回 ""
func ErrorCode(prefix string, err error) string {
	var code string
	var kb *knowledge.KbError
	var me *memory.MemError
	var se *schedule.SchedError
	switch {
	case errors.As(err, &kb):
		code = kb.Code
	case errors.As(err, &me):
		code = me.Code
	case errors.As(err, &se):
		code = se.Code
	default:
		return ""
	}
	m := prefix + "_" + strings.ReplaceAll(strings.ToUpper(code), "-", "_")
	if Declared[m] {
		return m
	}
	return ""
}

func mapped(prefix string, v any, err error) (any, error) {
	if err != nil {
		if c := ErrorCode(prefix, err); c != "" {
			return nil, &contract.Error{Code: c, Message: err.Error()}
		}
		return nil, err
	}
	return v, nil
}

func kbErr(v any, err error) (any, error)    { return mapped("KB", v, err) }
func memErr(v any, err error) (any, error)   { return mapped("MEM", v, err) }
func schedErr(v any, err error) (any, error) { return mapped("SCHED", v, err) }

func plain[T any](v T, err error) (any, error) {
	if err != nil {
		return nil, err
	}
	return v, nil
}

// Services：在调用时读取，缺了报 UNAVAILABLE（need()）
type Services struct {
	KB    func() *knowledge.Service
	Mem   func() *memory.Service
	Sched func() *schedule.Service
	Local func() *local.Service
	Hub   func() *local.Hub
	Ext   func() *extensions.Service
}

func unavailable(name string) error {
	return &contract.Error{Code: "UNAVAILABLE", Message: "Service '" + name + "' is not available"}
}

func need[T any](f func() *T, name string) (*T, error) {
	if f == nil {
		return nil, unavailable(name)
	}
	v := f()
	if v == nil {
		return nil, unavailable(name)
	}
	return v, nil
}

func decode(raw json.RawMessage, v any) error {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	if err := json.Unmarshal(raw, v); err != nil {
		return &contract.Error{Code: "BAD_INPUT", Message: err.Error()}
	}
	return nil
}

type H func(ctx context.Context, raw json.RawMessage) (any, error)

func on[T any](get func() (*T, error), f func(ctx context.Context, s *T, raw json.RawMessage) (any, error)) H {
	return func(ctx context.Context, raw json.RawMessage) (any, error) {
		s, err := get()
		if err != nil {
			return nil, err
		}
		return f(ctx, s, raw)
	}
}

type idIn struct {
	ID string `json:"id"`
}
type idEn struct {
	ID      string `json:"id"`
	Enabled bool   `json:"enabled"`
}
type nameIn struct {
	Name string `json:"name"`
}
type nameEn struct {
	Name    string `json:"name"`
	Enabled bool   `json:"enabled"`
}

func anyIn(raw json.RawMessage) (any, error) {
	var v any
	err := decode(raw, &v)
	return v, err
}

// Handlers：过程名 → 处理函数（测试直接调用）
func Handlers(sv Services) map[string]H {
	kb := func() (*knowledge.Service, error) { return need(sv.KB, "kb") }
	mem := func() (*memory.Service, error) { return need(sv.Mem, "mem") }
	sched := func() (*schedule.Service, error) { return need(sv.Sched, "sched") }
	loc := func() (*local.Service, error) { return need(sv.Local, "localModels") }
	hub := func() (*local.Hub, error) { return need(sv.Hub, "localHub") }
	ext := func() (*extensions.Service, error) { return need(sv.Ext, "ext") }
	type K = knowledge.Service
	type M = memory.Service
	type S = schedule.Service
	type L = local.Service
	type E = extensions.Service

	return map[string]H{
		// ---------- kb ----------
		"kb.state": on(kb, func(_ context.Context, s *K, _ json.RawMessage) (any, error) { return s.State(), nil }),
		"kb.docs": on(kb, func(_ context.Context, s *K, raw json.RawMessage) (any, error) {
			var in struct {
				SourceID string `json:"sourceId"`
				Filter   string `json:"filter"`
			}
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return s.Docs(in.SourceID, in.Filter), nil
		}),
		"kb.addFolder": on(kb, func(ctx context.Context, s *K, _ json.RawMessage) (any, error) { return kbErr(s.AddFolder(ctx)) }),
		"kb.removeSource": on(kb, func(_ context.Context, s *K, raw json.RawMessage) (any, error) {
			var in idIn
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return s.RemoveSource(in.ID), nil
		}),
		"kb.toggleSource": on(kb, func(_ context.Context, s *K, raw json.RawMessage) (any, error) {
			var in idEn
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return s.SetSourceEnabled(in.ID, in.Enabled), nil
		}),
		"kb.setSettings": on(kb, func(_ context.Context, s *K, raw json.RawMessage) (any, error) {
			p, err := anyIn(raw)
			if err != nil {
				return nil, err
			}
			return s.SetSettings(p), nil
		}),
		"kb.consentCloud": on(kb, func(_ context.Context, s *K, raw json.RawMessage) (any, error) {
			var in struct {
				ProviderID string `json:"providerId"`
			}
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return s.ConsentCloud(in.ProviderID), nil
		}),
		"kb.test": on(kb, func(ctx context.Context, s *K, raw json.RawMessage) (any, error) {
			var in struct {
				Kind string `json:"kind"`
			}
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return s.TestEndpoint(ctx, in.Kind), nil
		}),
		"kb.reindex": on(kb, func(_ context.Context, s *K, raw json.RawMessage) (any, error) {
			var in struct {
				Force *bool `json:"force"`
			}
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return s.StartReindex(in.Force != nil && *in.Force), nil
		}),
		"kb.cancel": on(kb, func(_ context.Context, s *K, _ json.RawMessage) (any, error) { return s.CancelIndex(), nil }),
		"kb.clear":  on(kb, func(_ context.Context, s *K, _ json.RawMessage) (any, error) { return s.Clear(), nil }),
		"kb.search": on(kb, func(ctx context.Context, s *K, raw json.RawMessage) (any, error) {
			var in struct {
				Q string `json:"q"`
			}
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return s.Search(ctx, in.Q, 0), nil
		}),
		"kb.ask": on(kb, func(ctx context.Context, s *K, raw json.RawMessage) (any, error) {
			var in struct {
				Q       string `json:"q"`
				History any    `json:"history"`
			}
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			if in.History == nil {
				in.History = []any{}
			}
			return kbErr(s.AskFromView(ctx, in.Q, in.History))
		}),
		"kb.open": on(kb, func(ctx context.Context, s *K, raw json.RawMessage) (any, error) {
			var in struct {
				DocID string `json:"docId"`
				How   string `json:"how"`
			}
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			if in.How == "" {
				in.How = "open"
			}
			return s.Open(ctx, in.DocID, in.How), nil
		}),
		"kb.ocrDownload": on(kb, func(ctx context.Context, s *K, raw json.RawMessage) (any, error) {
			var in idIn
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return s.DownloadOcr(ctx, in.ID), nil
		}),
		"kb.ocrCancel": on(kb, func(_ context.Context, s *K, raw json.RawMessage) (any, error) {
			var in idIn
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return s.CancelOcr(in.ID), nil
		}),
		"kb.ocrRemove": on(kb, func(_ context.Context, s *K, raw json.RawMessage) (any, error) {
			var in idIn
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return s.RemoveOcr(in.ID), nil
		}),

		// ---------- mem ----------
		"mem.state": on(mem, func(_ context.Context, s *M, _ json.RawMessage) (any, error) { return s.State(), nil }),
		"mem.list": on(mem, func(_ context.Context, s *M, raw json.RawMessage) (any, error) {
			var in struct {
				Filter string `json:"filter"`
			}
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return s.List(in.Filter), nil
		}),
		"mem.setSettings": on(mem, func(_ context.Context, s *M, raw json.RawMessage) (any, error) {
			p, err := anyIn(raw)
			if err != nil {
				return nil, err
			}
			return s.SetSettings(p), nil
		}),
		"mem.persona": on(mem, func(_ context.Context, s *M, _ json.RawMessage) (any, error) { return s.Persona(), nil }),
		"mem.setPersona": on(mem, func(_ context.Context, s *M, raw json.RawMessage) (any, error) {
			var in struct {
				Text string `json:"text"`
			}
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return plain(s.SetPersona(in.Text))
		}),
		"mem.openPersona": on(mem, func(_ context.Context, s *M, _ json.RawMessage) (any, error) { return plain(s.OpenPersona()) }),
		"mem.ingest": on(mem, func(ctx context.Context, s *M, raw json.RawMessage) (any, error) {
			var in struct {
				ConversationID string `json:"conversationId"`
				Messages       any    `json:"messages"`
				Force          *bool  `json:"force"`
			}
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return memErr(s.IngestFromView(ctx, in.ConversationID, in.Messages, in.Force != nil && *in.Force))
		}),
		"mem.context": on(mem, func(ctx context.Context, s *M, raw json.RawMessage) (any, error) {
			var in struct {
				Q string `json:"q"`
			}
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return s.Context(ctx, sliceUTF16(in.Q, 4000)), nil
		}),
		"mem.updateEpisode": on(mem, func(ctx context.Context, s *M, raw json.RawMessage) (any, error) {
			var in struct {
				ID    string `json:"id"`
				Patch any    `json:"patch"`
			}
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return memErr(s.UpdateEpisode(ctx, in.ID, in.Patch))
		}),
		"mem.upsertFact": on(mem, func(ctx context.Context, s *M, raw json.RawMessage) (any, error) {
			p, err := anyIn(raw)
			if err != nil {
				return nil, err
			}
			return memErr(s.UpsertFact(ctx, p))
		}),
		"mem.remove": on(mem, func(_ context.Context, s *M, raw json.RawMessage) (any, error) {
			var in struct {
				Kind string `json:"kind"`
				ID   string `json:"id"`
			}
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return s.Remove(in.Kind, in.ID), nil
		}),
		"mem.clear":    on(mem, func(_ context.Context, s *M, _ json.RawMessage) (any, error) { return s.ClearAll(), nil }),
		"mem.backfill": on(mem, func(ctx context.Context, s *M, _ json.RawMessage) (any, error) { return s.BackfillVectors(ctx), nil }),
		"mem.profile":  on(mem, func(_ context.Context, s *M, _ json.RawMessage) (any, error) { return s.Profile(), nil }),
		"mem.resetProfile": on(mem, func(ctx context.Context, s *M, _ json.RawMessage) (any, error) {
			return plain(s.ResetProfile(ctx))
		}),
		"mem.export": on(mem, func(ctx context.Context, s *M, raw json.RawMessage) (any, error) {
			var in struct {
				Format string `json:"format"`
			}
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return plain(s.ExportToFile(ctx, in.Format))
		}),

		// ---------- sched ----------
		"sched.state": on(sched, func(_ context.Context, s *S, _ json.RawMessage) (any, error) { return s.State(), nil }),
		"sched.setSettings": on(sched, func(_ context.Context, s *S, raw json.RawMessage) (any, error) {
			p, err := anyIn(raw)
			if err != nil {
				return nil, err
			}
			return s.SetSettings(p), nil
		}),
		"sched.upsertTask": on(sched, func(_ context.Context, s *S, raw json.RawMessage) (any, error) {
			p, err := anyIn(raw)
			if err != nil {
				return nil, err
			}
			return schedErr(s.UpsertTask(p))
		}),
		"sched.toggleTask": on(sched, func(_ context.Context, s *S, raw json.RawMessage) (any, error) {
			var in idEn
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return s.SetTaskEnabled(in.ID, in.Enabled), nil
		}),
		"sched.removeTask": on(sched, func(_ context.Context, s *S, raw json.RawMessage) (any, error) {
			var in idIn
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return s.RemoveTask(in.ID), nil
		}),
		"sched.runTask": on(sched, func(ctx context.Context, s *S, raw json.RawMessage) (any, error) {
			var in idIn
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return schedErr(s.RunTask(ctx, in.ID, schedule.RunOpts{Manual: true}))
		}),
		"sched.results":      on(sched, func(_ context.Context, s *S, _ json.RawMessage) (any, error) { return s.Results(), nil }),
		"sched.clearResults": on(sched, func(_ context.Context, s *S, _ json.RawMessage) (any, error) { return s.ClearResults(), nil }),
		"sched.proactiveNow": on(sched, func(ctx context.Context, s *S, _ json.RawMessage) (any, error) {
			return schedErr(s.ProactiveNow(ctx))
		}),
		"sched.activity": on(sched, func(_ context.Context, s *S, _ json.RawMessage) (any, error) {
			s.NoteActivity()
			return true, nil
		}),

		// ---------- local ----------
		"local.state": on(loc, func(_ context.Context, s *L, _ json.RawMessage) (any, error) { return s.State(), nil }),
		"local.setSettings": on(loc, func(_ context.Context, s *L, raw json.RawMessage) (any, error) {
			p := map[string]any{}
			if err := decode(raw, &p); err != nil {
				return nil, err
			}
			return s.SetSettings(p), nil
		}),
		"local.download": on(loc, func(_ context.Context, s *L, raw json.RawMessage) (any, error) {
			var in idIn
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return s.Download(in.ID), nil
		}),
		"local.downloadRuntime": on(loc, func(_ context.Context, s *L, _ json.RawMessage) (any, error) { return s.DownloadRuntime(), nil }),
		"local.cancel": on(loc, func(_ context.Context, s *L, raw json.RawMessage) (any, error) {
			var in idIn
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return s.Cancel(in.ID), nil
		}),
		"local.remove": on(loc, func(_ context.Context, s *L, raw json.RawMessage) (any, error) {
			var in idIn
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return s.Remove(in.ID), nil
		}),
		"local.removeRuntime": on(loc, func(_ context.Context, s *L, _ json.RawMessage) (any, error) { return plain(s.RemoveRuntime()) }),
		"local.start": on(loc, func(_ context.Context, s *L, raw json.RawMessage) (any, error) {
			var in idIn
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return plain(s.Start(in.ID))
		}),
		"local.stop": on(loc, func(_ context.Context, s *L, _ json.RawMessage) (any, error) { return s.Stop(), nil }),
		"local.use":  on(loc, func(_ context.Context, s *L, _ json.RawMessage) (any, error) { return plain(s.UseAsChat()) }),
		"local.offline": on(loc, func(_ context.Context, s *L, raw json.RawMessage) (any, error) {
			var in struct {
				Enabled bool `json:"enabled"`
			}
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return plain(s.SetOffline(in.Enabled))
		}),
		"local.ollamaList": on(loc, func(_ context.Context, s *L, _ json.RawMessage) (any, error) { return plain(s.OllamaList()) }),
		"local.ollamaPull": on(loc, func(_ context.Context, s *L, raw json.RawMessage) (any, error) {
			var in nameIn
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return plain(s.OllamaPull(in.Name))
		}),
		"local.ollamaDelete": on(loc, func(_ context.Context, s *L, raw json.RawMessage) (any, error) {
			var in nameIn
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return plain(s.OllamaDelete(in.Name))
		}),

		// ---------- hub ----------
		"hub.export": on(hub, func(ctx context.Context, s *local.Hub, raw json.RawMessage) (any, error) {
			var in local.ExportOpts
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			r, err := s.ExportAll(ctx, in)
			if err != nil {
				return nil, err
			}
			if r == nil {
				return nil, nil
			}
			return r, nil
		}),

		// ---------- ext ----------
		"ext.mcpList": on(ext, func(_ context.Context, s *E, _ json.RawMessage) (any, error) { return s.ListMcp(), nil }),
		"ext.mcpUpsert": on(ext, func(ctx context.Context, s *E, raw json.RawMessage) (any, error) {
			p := map[string]any{}
			if err := decode(raw, &p); err != nil {
				return nil, err
			}
			return plain(s.Upsert(ctx, p))
		}),
		"ext.mcpRemove": on(ext, func(ctx context.Context, s *E, raw json.RawMessage) (any, error) {
			var in idIn
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return s.Remove(ctx, in.ID), nil
		}),
		"ext.mcpToggle": on(ext, func(ctx context.Context, s *E, raw json.RawMessage) (any, error) {
			var in idEn
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return s.Toggle(ctx, in.ID, in.Enabled), nil
		}),
		"ext.mcpConnect": on(ext, func(ctx context.Context, s *E, raw json.RawMessage) (any, error) {
			var in idIn
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return plain(s.Connect(ctx, in.ID))
		}),
		"ext.mcpDisconnect": on(ext, func(ctx context.Context, s *E, raw json.RawMessage) (any, error) {
			var in idIn
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			s.Disconnect(ctx, in.ID)
			return nil, nil // Node: async () => undefined
		}),
		"ext.mcpImport": on(ext, func(_ context.Context, s *E, raw json.RawMessage) (any, error) {
			var in struct {
				Text string `json:"text"`
			}
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return plain(s.ImportJSON(in.Text))
		}),
		"ext.skillsList": on(ext, func(_ context.Context, s *E, _ json.RawMessage) (any, error) { return s.ListSkills(), nil }),
		"ext.skillGet": on(ext, func(_ context.Context, s *E, raw json.RawMessage) (any, error) {
			var in nameIn
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return plain(s.GetSkill(in.Name))
		}),
		"ext.skillSave": on(ext, func(_ context.Context, s *E, raw json.RawMessage) (any, error) {
			var in struct {
				Meta         extensions.SkillMeta `json:"meta"`
				Body         string               `json:"body"`
				OriginalName string               `json:"originalName"`
			}
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return plain(s.SaveSkill(in.Meta, in.Body, in.OriginalName))
		}),
		"ext.skillRemove": on(ext, func(_ context.Context, s *E, raw json.RawMessage) (any, error) {
			var in nameIn
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return plain(s.RemoveSkill(in.Name))
		}),
		"ext.skillToggle": on(ext, func(_ context.Context, s *E, raw json.RawMessage) (any, error) {
			var in nameEn
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return s.ToggleSkill(in.Name, in.Enabled), nil
		}),
		"ext.skillImport": on(ext, func(ctx context.Context, s *E, _ json.RawMessage) (any, error) {
			m, err := s.ImportSkillDialog(ctx)
			if err != nil {
				return nil, err
			}
			if m == nil {
				return nil, nil
			}
			return m, nil
		}),
		"ext.skillOpen": on(ext, func(_ context.Context, s *E, raw json.RawMessage) (any, error) {
			var in nameIn
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return plain(s.OpenSkill(in.Name))
		}),
		"ext.skillsContext": on(ext, func(_ context.Context, s *E, _ json.RawMessage) (any, error) { return s.SkillsContext(), nil }),
		"ext.migrateScan": on(ext, func(ctx context.Context, s *E, raw json.RawMessage) (any, error) {
			var in struct {
				PickProject  any `json:"pickProject"`
				ClearProject any `json:"clearProject"`
			}
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return plain(s.MigrateScan(ctx, truthy(in.PickProject), truthy(in.ClearProject)))
		}),
		"ext.migrateImport": on(ext, func(ctx context.Context, s *E, raw json.RawMessage) (any, error) {
			var in struct {
				Items []extensions.MigrateChoice `json:"items"`
			}
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return s.MigrateImport(ctx, in.Items), nil
		}),
	}
}

func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case float64:
		return x != 0 && x == x
	case string:
		return x != ""
	}
	return true
}

func sliceUTF16(s string, n int) string {
	if len(s) <= n { // 字节数 ≤ n 时 UTF-16 长度必然 ≤ n
		return s
	}
	return extensionsSlice(s, n)
}

// Install：把 77 个过程挂到 Router（在 procs.Install 之前调用）
func Install(r *contract.Router, sv Services) int {
	hs := Handlers(sv)
	for name, h := range hs {
		h := h
		r.Call(name, func(ctx context.Context, _ contract.Caller, raw json.RawMessage) (any, error) { return h(ctx, raw) })
	}
	return len(hs)
}

func extensionsSlice(s string, n int) string { return depsSlice0(s, n) }
func depsSlice0(s string, n int) string      { return deps.Slice0(s, n) }
