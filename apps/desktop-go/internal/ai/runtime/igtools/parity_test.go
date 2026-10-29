package igtools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/runtime/aifacade"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/delegate"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/extensions"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/memory"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// golden：scripts/parity/record-b7s-igtools.mjs（真实 createIgPluginHost + AIClient；kb / mem / ext 的 this 为假宿主）
const now0 = 1700000000000.0

type state struct {
	send     string
	hits     []any
	mode     string
	enabled  bool
	memText  string
	facts    []string
	provider any // 用例的 ctx.provider 原样（Node 形态 { providerId, model }）
}

type host struct {
	st    *state
	calls []any
	sb    string
}

func (h *host) rec(c ...any) { h.calls = append(h.calls, c) }

// ---- kb ----
func (h *host) CheckSend(_ context.Context, _ *tools.ToolCallProvider) string {
	h.rec("receiversFor", h.st.provider, []any{"chat", "agent-tools"})
	return h.st.send
}
func (h *host) Search(_ context.Context, q string, limit int) ([]KBHit, string) {
	h.rec("search", q, float64(limit))
	out := []KBHit{}
	for _, x := range h.st.hits {
		o := x.(*u.Obj)
		k := KBHit{Title: o.Get("title").(string), Path: o.Get("path").(string), Text: o.Get("text").(string)}
		if p, ok := o.Get("page").(float64); ok {
			k.Page = &p
		}
		out = append(out, k)
	}
	return out, h.st.mode
}
func (h *host) MarkRead(context.Context) { h.rec("markRead") }
func (h *host) Audit(q string) {
	h.rec("audit", u.NewObj("tool", "kb_search", "args", u.NewObj("query", q), "decision", "auto", "result", "ok", "source", "agent"))
}

// ---- mem（MemHost 的 Audit 与 kb 的同名，故拆类型）----
type memFake struct{ *host }

func (m memFake) Enabled() bool { return m.st.enabled }
func (m memFake) Context(_ context.Context, q string) string {
	m.rec("context", q)
	return m.st.memText
}
func (m memFake) Audit(tool string, args *u.Obj, res string) { m.rec("audit", tool, args, res) }
func (m memFake) Gesture(name string) {
	m.rec("publish", "avatar.event", u.NewObj("type", "gesture", "name", name))
}
func (m memFake) HasDuplicate(text string) bool {
	for _, f := range m.st.facts {
		if memory.IsDuplicateFact(f, text) {
			return true
		}
	}
	return false
}
func (m memFake) UpsertFact(_ context.Context, text, kind string) (string, error) {
	m.rec("upsert", u.NewObj("text", text, "kind", kind))
	return "fact_1", nil
}

// ---- ext（同 recorder 的 extThis：listSkills / getSkill / skillDir + 真实 fs）----
type skillFake struct{ *host }

var fakeSkills = []struct {
	name, body, err string
	enabled         bool
	files           []string
}{
	{"alpha", "# Alpha\nDo things.", "", true, []string{"ref.md", "bin.dat"}},
	{"off", "x", "", false, []string{}},
	{"broken", "", "bad frontmatter", true, []string{}},
}

func (s skillFake) enabled(name string) error {
	for _, x := range fakeSkills {
		if x.name == name {
			if x.err != "" {
				break
			}
			if !x.enabled {
				return errors.New(i18n.T("electron.common.skill-was-disabled-by-the-user", name))
			}
			return nil
		}
	}
	return errors.New(i18n.T("electron.common.no-skill-named", name))
}

func (s skillFake) SkillLoad(name string) (map[string]any, error) {
	if err := s.enabled(name); err != nil {
		return nil, err
	}
	for _, x := range fakeSkills {
		if x.name == name {
			s.rec("audit", "skill_load", u.NewObj("name", name), "auto", "ok", "skill")
			s.rec("publish", "avatar.event", u.NewObj("type", "gesture", "name", "think"))
			fl := make([]any, len(x.files))
			for i, f := range x.files {
				fl[i] = f
			}
			return map[string]any{"name": name, "instructions": x.body, "files": fl}, nil
		}
	}
	return nil, errors.New("unreachable")
}

func (s skillFake) SkillReadFile(name, rel string) (map[string]any, error) {
	if err := s.enabled(name); err != nil {
		return nil, err
	}
	abs, err := extensions.SafeJoin(filepath.Join(s.sb, name), rel)
	if err != nil {
		return nil, err
	}
	st, err := os.Lstat(abs)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, fmt.Errorf("ENOENT: no such file or directory, lstat '%s'", abs)
		}
		return nil, err
	}
	if !st.Mode().IsRegular() {
		return nil, errors.New(i18n.T("electron.common.not-a-file"))
	}
	b, _ := os.ReadFile(abs)
	if strings.IndexByte(string(b), 0) >= 0 {
		return nil, errors.New(i18n.T("electron.common.only-text-files-can-be-read"))
	}
	s.rec("audit", "skill_read_file", u.NewObj("name", name, "path", rel), "auto", "ok", "skill")
	return map[string]any{"content": string(b)}, nil
}

// norm：JSON 往返后比较（键序不敏感；值/类型逐一）
func norm(t *testing.T, v any) any {
	t.Helper()
	var b []byte
	if o, ok := v.(*u.Obj); ok {
		b = []byte(u.Stringify(o))
	} else if a, ok := v.([]any); ok {
		b = []byte(u.Stringify(a))
	} else {
		var err error
		b, err = json.Marshal(v)
		if err != nil {
			b = []byte(u.Stringify(v))
		}
	}
	var out any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("norm %T: %v (%s)", v, err, b)
	}
	return out
}

func load(t *testing.T, name string, v any) {
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatal(err)
	}
}

type rig struct {
	reg   *tools.InMemory
	fac   *aifacade.Facade
	prof  *aifacade.ProfileStore
	h     *host
	clock *float64
	rnd   *[]float64
	cues  *[]any
}

func boot(t *testing.T) *rig {
	extensions.T = i18n.T // 生产由 knowledgehandlers.Wire 注入
	t.Cleanup(func() { extensions.T = i18n.Identity })
	sb := t.TempDir()
	if r, err := filepath.EvalSymlinks(sb); err == nil {
		sb = r
	}
	_ = os.MkdirAll(filepath.Join(sb, "alpha", "sub"), 0o755)
	_ = os.WriteFile(filepath.Join(sb, "alpha", "ref.md"), []byte("reference text ✓"), 0o644)
	_ = os.WriteFile(filepath.Join(sb, "alpha", "bin.dat"), []byte{1, 0, 2}, 0o644)
	clock := now0
	rnd := []float64{}
	cues := []any{}
	env := Env{Now: func() float64 { return clock }, Random: func() float64 {
		if len(rnd) == 0 {
			return 0.5
		}
		r := rnd[0]
		rnd = rnd[1:]
		return r
	}}
	prof := aifacade.NewProfileStore(aifacade.ProfilePath(t.TempDir()), env.Now)
	prof.Export()
	reg := tools.NewInMemory()
	var fac *aifacade.Facade
	h := &host{st: &state{}, sb: sb}
	defs := BuiltinTools(env)
	defs = append(defs, PreferenceTools(prof, env)...)
	defs = append(defs, CompanionTools(avatarRef{&fac}, true)...)
	dsvc := desktop.CreateService(t.TempDir(), desktop.Ports{Home: sb}, nil)
	defs = append(defs, DesktopTools(DeskDepsFor(dsvc, func() []string { return nil }))...)
	defs = append(defs, KBTools(h)...)
	defs = append(defs, MemTools(memFake{h})...)
	defs = append(defs, WithDangerousUnset(delegateStubs())...)
	defs = append(defs, SkillTools(skillFake{h})...)
	for _, d := range defs {
		reg.Register(d)
	}
	fac = aifacade.New(aifacade.Options{Now: env.Now, Tools: reg, Profile: prof, Avatar: true,
		AvatarHost: func(c *u.Obj) { cues = append(cues, c) }})
	return &rig{reg: reg, fac: fac, prof: prof, h: h, clock: &clock, rnd: &rnd, cues: &cues}
}

type avatarRef struct{ f **aifacade.Facade }

func (a avatarRef) AvatarGesture(n string) error             { return (*a.f).AvatarGesture(n) }
func (a avatarRef) AvatarEmotion(n string, w *float64) error { return (*a.f).AvatarEmotion(n, w) }

// delegateStubs：delegate 的 list 形状取自真实 DelegateService.Tools()（不执行）
func delegateStubs() []tools.Definition {
	return delegate.New(delegate.Deps{Root: filepath.Join(os.TempDir(), "igtools-parity-delegate-unused")}).Tools()
}

func TestIgToolsParityGolden(t *testing.T) {
	var golden struct {
		List    []any            `json:"list"`
		Schemas map[string]any   `json:"schemas"`
		Meta    []any            `json:"meta"`
		Exec    []map[string]any `json:"exec"`
	}
	load(t, "b7s-igtools.json", &golden)
	var cases []map[string]json.RawMessage
	load(t, "b7s-igtools-cases.json", &cases)
	r := boot(t)

	// ai.tools.list（ToolSpec：dangerous 仅 companion 出现）
	list, err := r.fac.ToolsList()
	if err != nil {
		t.Fatal(err)
	}
	if got := norm(t, list); !reflect.DeepEqual(got, norm(t, golden.List)) {
		t.Errorf("tools.list:\n got %s\nwant %s", u.Stringify(list), mustJSON(golden.List))
	}
	// 入参 JSON Schema + readOnly / requiresWorkspace
	meta := []any{}
	for _, d := range r.reg.List() {
		if want, ok := golden.Schemas[d.Name]; !ok {
			t.Errorf("extra tool %s", d.Name)
		} else if got := norm(t, tools.SchemaOf(d)); !reflect.DeepEqual(got, want) {
			t.Errorf("schema %s:\n got %s\nwant %s", d.Name, u.Stringify(tools.SchemaOf(d)), mustJSON(want))
		}
		m := map[string]any{"name": d.Name}
		if d.ReadOnly {
			m["readOnly"] = true
		}
		if d.RequiresWorkspace {
			m["requiresWorkspace"] = true
		}
		meta = append(meta, m)
	}
	if !reflect.DeepEqual(norm(t, meta), norm(t, golden.Meta)) {
		t.Errorf("meta:\n got %s\nwant %s", mustJSON(meta), mustJSON(golden.Meta))
	}

	if len(cases) != len(golden.Exec) {
		t.Fatalf("cases %d vs golden %d", len(cases), len(golden.Exec))
	}
	for i, c := range cases {
		var tool string
		_ = json.Unmarshal(c["tool"], &tool)
		if tool == "delegate_to_cli" || tool == "delegate_status" || tool == "delegate_followup" {
			continue // 执行体由 delegate 包自己的 parity 覆盖
		}
		got := r.run(t, c)
		want := golden.Exec[i]
		gs := strings.ReplaceAll(mustJSON(got), r.h.sb, "@@SB@@")
		var gn any
		_ = json.Unmarshal([]byte(gs), &gn)
		if !reflect.DeepEqual(gn, norm(t, want)) {
			t.Errorf("exec[%d] %s:\n got %s\nwant %s", i, tool, gs, mustJSON(want))
		}
	}
}

func (r *rig) run(t *testing.T, c map[string]json.RawMessage) map[string]any {
	var tool string
	_ = json.Unmarshal(c["tool"], &tool)
	*r.clock = now0
	if raw, ok := c["tick"]; ok {
		var tk float64
		_ = json.Unmarshal(raw, &tk)
		*r.clock = now0 + tk
	}
	*r.rnd = nil
	if raw, ok := c["rnd"]; ok {
		_ = json.Unmarshal(raw, r.rnd)
	}
	st := &state{send: "ok", hits: []any{}, mode: "bm25", enabled: true}
	if raw, ok := c["st"]; ok {
		v, _ := u.ParseString(string(raw))
		o := v.(*u.Obj)
		if x, ok := o.Get("send").(string); ok {
			st.send = x
		}
		if x, ok := o.Get("hits").([]any); ok {
			st.hits = x
		}
		if x, ok := o.Get("mode").(string); ok {
			st.mode = x
		}
		if x, ok := o.Get("memEnabled").(bool); ok {
			st.enabled = x
		}
		if x, ok := o.Get("memText").(string); ok {
			st.memText = x
		}
		if x, ok := o.Get("facts").([]any); ok {
			for _, f := range x {
				st.facts = append(st.facts, f.(string))
			}
		}
	}
	ec := tools.ExecContext{ToolCallID: "tc1"}
	if raw, ok := c["provider"]; ok {
		v, _ := u.ParseString(string(raw))
		st.provider = v
		id, _ := v.(*u.Obj).Get("providerId").(string)
		ec.Provider = &tools.ToolCallProvider{ID: id}
	}
	r.h.st, r.h.calls, *r.cues = st, nil, nil
	var in any = aifacade.Undef
	if raw, ok := c["in"]; ok {
		in, _ = u.ParseString(string(raw))
	}
	def, ok := r.reg.Get(tool)
	if !ok {
		t.Fatalf("no tool %s", tool)
	}
	rec := map[string]any{"tool": tool}
	out, err := def.Execute(context.Background(), in, ec)
	if err != nil {
		rec["err"] = err.Error()
	} else {
		rec["out"] = norm(t, out)
	}
	if len(r.h.calls) > 0 {
		rec["calls"] = norm(t, r.h.calls)
	}
	if len(*r.cues) > 0 {
		rec["cues"] = norm(t, *r.cues)
	}
	if _, ok := c["profile"]; ok {
		rec["profile"] = norm(t, r.prof.Get())
	}
	return rec
}

func mustJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return u.Stringify(v)
	}
	return string(b)
}
