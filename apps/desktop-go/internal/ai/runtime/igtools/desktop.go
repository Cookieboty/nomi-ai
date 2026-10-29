package igtools

import (
	"context"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// KBHit：knowledge 检索命中（Page nil = undefined）
type KBHit struct {
	Title, Path, Text string
	Page              *float64
}

// KBHost = KnowledgeService.tools() 的 this（d.desktop + search）
type KBHost interface {
	// CheckSend = checkSendAll(receiversFor(ctx.provider, ['chat','agent-tools']), signal)
	CheckSend(ctx context.Context, p *tools.ToolCallProvider) string
	Search(ctx context.Context, q string, limit int) (hits []KBHit, mode string)
	MarkRead(ctx context.Context)
	// Audit = d.desktop.audit.append({ tool:'kb_search', args:{query}, decision:'auto', result:'ok', source:'agent' })
	Audit(query string)
}

// MemHost = MemoryService.tools() 的 this
type MemHost interface {
	Enabled() bool
	Context(ctx context.Context, q string) string
	Audit(tool string, args *u.Obj, result string)
	HasDuplicate(text string) bool
	UpsertFact(ctx context.Context, text, kind string) (string, error)
	Gesture(name string)
}

// SkillHost = ExtensionsService 的 skill 执行体（错误 message 原样透出）
type SkillHost interface {
	SkillLoad(name string) (map[string]any, error)
	SkillReadFile(name, rel string) (map[string]any, error)
}

func desc(key string) string { return u.Stringify(i18n.T(key)) }

func fail(code, msg string) *u.Obj {
	return u.NewObj("ok", false, "error", u.NewObj("code", code, "message", msg))
}

func okData(d any) *u.Obj { return u.NewObj("ok", true, "data", d) }

// KBTools = KnowledgeService.tools()
func KBTools(h KBHost) []tools.Definition {
	return []tools.Definition{{
		Name:           "kb_search",
		Description:    i18n.T("electron.common.search-the-user-s-local-knowledge-base-added"),
		Input:          schema(kbSearchSchema, "%D", desc("electron.common.the-question-or-keywords-to-look-up-in")),
		DangerousUnset: true,
		Execute: func(ctx context.Context, in any, ec tools.ExecContext) (any, error) {
			o, err := parse(kbIn, in)
			if err != nil {
				return nil, err
			}
			switch h.CheckSend(ctx, ec.Provider) {
			case "local_only":
				return fail("local_only", i18n.T("electron.common.only-local-models-cloud-service")), nil
			case "user_denied":
				return fail("user_denied", i18n.T("electron.common.the-user-didn-t-agree-to-send-knowledge")), nil
			}
			q := o.Get("query").(string)
			hits, mode := h.Search(ctx, q, int(o.Get("limit").(float64)))
			h.MarkRead(ctx)
			h.Audit(deps.Slice0(q, 80))
			res := make([]any, len(hits))
			for n, x := range hits {
				r := u.NewObj("n", float64(n+1), "source", x.Title)
				if len(x.Path) < 5 || x.Path[:5] != "note:" {
					r.Set("path", x.Path)
				}
				if x.Page != nil {
					r.Set("page", *x.Page)
				}
				r.Set("text", i18n.T("electron.common.untrusted-material-end-of-material", x.Title, x.Text))
				res[n] = r
			}
			return okData(u.NewObj("mode", mode, "results", res)), nil
		},
	}}
}

// MemTools = MemoryService.tools()：disabled 检查先于 parse
func MemTools(h MemHost) []tools.Definition {
	disabled := func() *u.Obj {
		return fail("disabled", i18n.T("electron.common.the-user-turned-off-long-term-memory"))
	}
	return []tools.Definition{
		{
			Name:           "memory_search",
			Description:    i18n.T("electron.common.search-local-long-term-memory-past-conversation-summaries"),
			Input:          schema(memSearchSchema, "%D", desc("electron.common.topic-or-keywords-to-recall")),
			DangerousUnset: true,
			Execute: func(ctx context.Context, in any, _ tools.ExecContext) (any, error) {
				if !h.Enabled() {
					return disabled(), nil
				}
				o, err := parse(memSearchIn, in)
				if err != nil {
					return nil, err
				}
				q := o.Get("query").(string)
				text := h.Context(ctx, q)
				h.Audit("memory_search", u.NewObj("query", deps.Slice0(q, 80)), "ok")
				if text == "" {
					text = i18n.T("electron.common.no-relevant-memories")
				}
				return okData(u.NewObj("memory", text)), nil
			},
		},
		{
			Name:           "memory_remember",
			Description:    i18n.T("electron.common.only-when-the-user-explicitly-asks-to-remember"),
			Input:          schema(memRememberT, "%D", desc("electron.common.a-one-sentence-fact-about-the-user-that")),
			DangerousUnset: true,
			Execute: func(ctx context.Context, in any, _ tools.ExecContext) (any, error) {
				if !h.Enabled() {
					return disabled(), nil
				}
				o, err := parse(memRememberIn, in)
				if err != nil {
					return nil, err
				}
				text := o.Get("text").(string)
				if h.HasDuplicate(text) {
					return okData(u.NewObj("saved", false, "reason", i18n.T("electron.common.already-remembered"))), nil
				}
				id, err := h.UpsertFact(ctx, text, o.Get("kind").(string))
				if err != nil {
					return nil, err
				}
				h.Gesture("nod")
				return okData(u.NewObj("saved", true, "id", id)), nil
			},
		},
	}
}

// SkillTools = ExtensionsService.tools()：所有异常（含 ZodError）→ { ok:false, error:{ code:'skill' } }
func SkillTools(h SkillHost) []tools.Definition {
	wrap := func(r map[string]any, err error) (any, error) {
		if err != nil {
			return fail("skill", err.Error()), nil
		}
		return okData(r), nil
	}
	return []tools.Definition{
		{
			Name:           "skill_load",
			Description:    i18n.T("electron.common.read-the-full-instructions-of-an-enabled-skill"),
			Input:          schema(skillLoadT, "%D", desc("electron.common.skill-name")),
			ReadOnly:       true,
			DangerousUnset: true,
			Execute: func(_ context.Context, in any, _ tools.ExecContext) (any, error) {
				o, err := parse(skillLoadIn, in)
				if err != nil {
					return wrap(nil, err)
				}
				return wrap(h.SkillLoad(o.Get("name").(string)))
			},
		},
		{
			Name:           "skill_read_file",
			Description:    i18n.T("electron.common.read-a-reference-file-in-a-skill-folder"),
			Input:          schema(skillReadT, "%D", desc("electron.common.relative-path-inside-the-skill-folder")),
			ReadOnly:       true,
			DangerousUnset: true,
			Execute: func(_ context.Context, in any, _ tools.ExecContext) (any, error) {
				o, err := parse(skillReadIn, in)
				if err != nil {
					return wrap(nil, err)
				}
				return wrap(h.SkillReadFile(o.Get("name").(string), o.Get("path").(string)))
			},
		},
	}
}

// WithDangerousUnset：delegate.tools() 等未声明 dangerous 的外部定义 → undefined（ToolSpec 不出 dangerous 键）
func WithDangerousUnset(defs []tools.Definition) []tools.Definition {
	out := make([]tools.Definition, len(defs))
	for i, d := range defs {
		if !d.Dangerous {
			d.DangerousUnset = true
		}
		out[i] = d
	}
	return out
}
