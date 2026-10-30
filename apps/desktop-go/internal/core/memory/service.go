package memory

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/knowledge"
)

// Facade：主进程 AIClient.memory（MemoryFacade）的切片。
// main.go 注入 aifacade；nil 时跳过同步（与 Node facade() 返回 null 一致）。
type Facade interface {
	PutFact(f map[string]any)
	DeleteFact(id string) bool
	PutSummary(s map[string]any)
	Profile() any
	ResetProfile(ctx context.Context) error
}

type EmbedFunc func(ctx context.Context, texts []string) ([][]float32, error)

type Deps struct {
	Root     string
	Logger   deps.Logger
	Desktop  deps.Desktop
	Complete deps.CompleteFunc
	// Embed：复用知识库的向量服务；返回 nil 表示未配置
	Embed  EmbedFunc
	Facade func() Facade
	Ports  deps.Ports
	Events deps.Events
	T      i18n.Translate
	Now    func() int64
	NewID  func() string
}

// MemError → 契约错误码 MEM_<UPPER_SNAKE(code)>
type MemError struct{ Code, Msg string }

func (e *MemError) Error() string { return e.Msg }

const (
	summaryWindow  = 80
	maxEpisodes    = 2000
	maxFacts       = 500
	historyCap     = 1000
	resyncLookback = 200
)

type store struct {
	V        int       `json:"v"`
	Episodes []Episode `json:"episodes"`
	Facts    []Fact    `json:"facts"`
}

type Service struct {
	d         Deps
	mu        sync.Mutex
	settings  Settings
	data      store
	busy      []string
	saveTimer *time.Timer
	lastError string
}

func New(d Deps) *Service {
	if d.Now == nil {
		d.Now = func() int64 { return time.Now().UnixMilli() }
	}
	if d.NewID == nil {
		d.NewID = deps.RandomUUID
	}
	if d.T == nil {
		d.T = i18n.Identity
	}
	if d.Facade == nil {
		d.Facade = func() Facade { return nil }
	}
	if d.Embed == nil {
		d.Embed = func(context.Context, []string) ([][]float32, error) { return nil, nil }
	}
	s := &Service{d: d, settings: DefaultSettings, data: store{V: 1, Episodes: []Episode{}, Facts: []Fact{}}}
	if b, err := os.ReadFile(s.file("settings.json")); err == nil {
		if v, err := deps.ParseJSON(b); err == nil {
			s.settings = SanitizeSettings(v)
		}
	}
	if b, err := os.ReadFile(s.file("memory.json")); err == nil {
		var raw struct {
			Episodes any `json:"episodes"`
			Facts    any `json:"facts"`
		}
		if deps.UnmarshalLoose(b, &raw) == nil {
			if arr, ok := raw.Episodes.([]any); ok {
				s.data.Episodes = decodeArr[Episode](arr)
			}
			if arr, ok := raw.Facts.([]any); ok {
				s.data.Facts = decodeArr[Fact](arr)
			}
		}
	}
	s.syncFacade()
	return s
}

func decodeArr[T any](arr []any) []T {
	out := make([]T, 0, len(arr))
	for _, x := range arr {
		var v T
		b := []byte(deps.MustStringify(x, ""))
		_ = deps.UnmarshalLoose(b, &v)
		out = append(out, v)
	}
	return out
}

func (s *Service) file(n string) string { return filepath.Join(s.d.Root, n) }

func (s *Service) writeJSON(n string, v any) error {
	if err := os.MkdirAll(s.d.Root, 0o755); err != nil {
		return err
	}
	b, err := deps.Stringify(v, "")
	if err != nil {
		return err
	}
	tmp := s.file(n + ".tmp")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.file(n))
}

// persistLocked：300ms 防抖写 memory.json；now=true 立即写
func (s *Service) persistLocked(now bool) {
	if s.saveTimer != nil {
		s.saveTimer.Stop()
		s.saveTimer = nil
	}
	if now {
		s.saveNowLocked()
	} else {
		s.saveTimer = time.AfterFunc(300*time.Millisecond, func() {
			s.mu.Lock()
			defer s.mu.Unlock()
			s.saveNowLocked()
		})
	}
	s.broadcast("mem.changed", nil)
}

func (s *Service) saveNowLocked() {
	s.saveTimer = nil
	if err := s.writeJSON("memory.json", s.data); err != nil && s.d.Logger != nil {
		s.d.Logger.Warn("memory save failed", "err", err)
	}
}

func (s *Service) Flush() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.saveTimer != nil {
		s.persistLocked(true)
	}
}

func (s *Service) syncFacade() {
	f := s.d.Facade()
	if f == nil {
		return
	}
	defer func() { _ = recover() }()
	for _, x := range s.data.Facts {
		f.PutFact(map[string]any{"id": x.ID, "kind": x.Kind, "text": x.Text, "source": x.Source, "at": x.UpdatedAt})
	}
	for _, e := range s.data.Episodes {
		f.PutSummary(map[string]any{"sessionId": e.ConversationID, "summary": e.Summary, "updatedAt": e.UpdatedAt, "stepCount": e.MessageCount})
	}
}

// ---------- 设置 / 档案 ----------

func (s *Service) Settings() Settings { s.mu.Lock(); defer s.mu.Unlock(); return s.settings }

func (s *Service) SetSettings(patch any) Settings {
	s.mu.Lock()
	cur, _ := deps.ParseJSON([]byte(deps.MustStringify(s.settings, "")))
	m := obj(cur)
	for k, v := range obj(patch) {
		m[k] = v
	}
	s.settings = SanitizeSettings(m)
	_ = s.writeJSON("settings.json", s.settings)
	out := s.settings
	s.mu.Unlock()
	s.broadcast("mem.changed", nil)
	return out
}

func (s *Service) PersonaFile() string { return s.file("persona.md") }

func (s *Service) Persona() string {
	b, err := os.ReadFile(s.PersonaFile())
	if err != nil {
		return ""
	}
	return string(b)
}

func (s *Service) SetPersona(text string) (bool, error) {
	if err := os.MkdirAll(s.d.Root, 0o755); err != nil {
		return false, err
	}
	if err := os.WriteFile(s.PersonaFile(), []byte(deps.Slice0(text, 8000)), 0o600); err != nil {
		return false, err
	}
	s.audit("memory_persona_save", deps.O(), "ok", nil)
	s.broadcast("mem.changed", nil)
	return true, nil
}

func (s *Service) OpenPersona() (bool, error) {
	if _, err := os.Stat(s.PersonaFile()); err != nil {
		if _, err := s.SetPersona(""); err != nil {
			return false, err
		}
	}
	return s.d.Ports.OpenPath(s.PersonaFile()) == "", nil
}

// ---------- 摘要 ----------

type IngestResult struct {
	Episode *EpisodeView `json:"episode,omitempty"`
	Skipped string       `json:"skipped,omitempty"`
}

// EpisodeView：view()，vec 只回 '1' 标记
type EpisodeView = Episode

func (s *Service) Ingest(ctx context.Context, conversationID string, msgs []TurnMsg, force bool) (IngestResult, error) {
	s.mu.Lock()
	st := s.settings
	if !st.Enabled {
		s.mu.Unlock()
		return IngestResult{Skipped: "disabled"}, nil
	}
	if !force && !st.AutoSummarize {
		s.mu.Unlock()
		return IngestResult{Skipped: "auto-off"}, nil
	}
	all := []TurnMsg{}
	for _, m := range msgs {
		if (m.Role == "user" || m.Role == "assistant") && deps.Trim(m.Content) != "" {
			all = append(all, m)
		}
	}
	total := len(all)
	clean := all
	if len(clean) > summaryWindow {
		clean = clean[len(clean)-summaryWindow:]
	}
	var prev *Episode
	for i := range s.data.Episodes {
		if s.data.Episodes[i].ConversationID == conversationID {
			p := s.data.Episodes[i]
			prev = &p
			break
		}
	}
	minN := st.MinMessages
	if force {
		minN = 2
	}
	if total < minN {
		s.mu.Unlock()
		return IngestResult{Skipped: "too-short"}, nil
	}
	sig := windowSig(all, total-1, nil)
	if prev != nil && !force && newSinceLast(all, *prev) < 2 {
		s.mu.Unlock()
		return IngestResult{Skipped: "no-new"}, nil
	}
	if prev != nil && prev.Edited && !force {
		s.mu.Unlock()
		return IngestResult{Skipped: "edited"}, nil
	}
	for _, b := range s.busy {
		if b == conversationID {
			s.mu.Unlock()
			return IngestResult{Skipped: "busy"}, nil
		}
	}
	s.busy = append(s.busy, conversationID)
	busy := append([]string{}, s.busy...)
	s.mu.Unlock()
	s.broadcast("mem.status", map[string]any{"busy": busy})
	t0 := time.Now()
	defer func() {
		s.mu.Lock()
		for i, b := range s.busy {
			if b == conversationID {
				s.busy = append(s.busy[:i], s.busy[i+1:]...)
				break
			}
		}
		busy := append([]string{}, s.busy...)
		s.mu.Unlock()
		s.broadcast("mem.status", map[string]any{"busy": busy})
	}()
	fail := func(err error) (IngestResult, error) {
		s.mu.Lock()
		s.lastError = err.Error()
		le := s.lastError
		s.mu.Unlock()
		s.audit("memory_summarize", deps.O("conversation", conversationID), "error", nil)
		if me, ok := err.(*MemError); ok {
			return IngestResult{}, me
		}
		return IngestResult{}, &MemError{"summarize-failed", s.d.T("electron.common.summarize-failed", le)}
	}
	cctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	raw, err := s.d.Complete(cctx, SummaryPrompt(clean))
	cancel()
	if err != nil {
		return fail(err)
	}
	p := ParseSummary(raw)
	if p == nil {
		return fail(&MemError{"bad-summary", s.d.T("electron.common.the-model-returned-no-usable-summary")})
	}
	now := s.d.Now()
	var ep Episode
	if prev != nil {
		ep = *prev
		ep.Title, ep.Summary, ep.Keywords = p.Title, p.Summary, p.Keywords
		ep.UpdatedAt, ep.MessageCount, ep.WindowSig, ep.Edited, ep.Vec = now, total, sig, false, ""
	} else {
		ep = Episode{ID: s.d.NewID(), ConversationID: conversationID, Title: p.Title, Summary: p.Summary,
			Keywords: p.Keywords, CreatedAt: now, UpdatedAt: now, MessageCount: total, WindowSig: sig}
	}
	s.mu.Lock()
	newFacts := []Fact{}
	for _, f := range p.Facts {
		dup := false
		for _, x := range s.data.Facts {
			if IsDuplicateFact(x.Text, f.Text) {
				dup = true
				break
			}
		}
		if dup {
			continue
		}
		newFacts = append(newFacts, Fact{ID: s.d.NewID(), Kind: f.Kind, Text: f.Text, Source: "distilled", CreatedAt: now, UpdatedAt: now, EpisodeID: ep.ID})
	}
	s.mu.Unlock()
	eps := []Episode{ep}
	s.embedItems(ctx, eps, newFacts)
	ep = eps[0]
	s.mu.Lock()
	replaced := false
	if prev != nil {
		for i := range s.data.Episodes {
			if s.data.Episodes[i].ID == prev.ID {
				s.data.Episodes[i] = ep
				replaced = true
			}
		}
	}
	if !replaced && prev == nil {
		s.data.Episodes = append(s.data.Episodes, ep)
	}
	s.data.Facts = append(s.data.Facts, newFacts...)
	s.trimLocked()
	s.persistLocked(false)
	s.lastError = ""
	s.mu.Unlock()
	s.syncFacade()
	ms := time.Since(t0).Milliseconds()
	s.audit("memory_summarize", deps.O("conversation", conversationID, "facts", len(newFacts)), "ok", &ms)
	deps.AvatarGesture(s.d.Events, "nod")
	v := viewEp(ep)
	return IngestResult{Episode: &v}, nil
}

func (s *Service) trimLocked() {
	if len(s.data.Episodes) > maxEpisodes {
		keep := append([]Episode{}, s.data.Episodes...)
		sortEpisodes(keep)
		s.data.Episodes = keep[:maxEpisodes]
	}
	if len(s.data.Facts) > maxFacts {
		s.data.Facts = append([]Fact{}, s.data.Facts[len(s.data.Facts)-maxFacts:]...)
	}
}

func sortEpisodes(e []Episode) {
	sort.SliceStable(e, func(i, j int) bool {
		if e[i].Pinned != e[j].Pinned {
			return e[i].Pinned
		}
		return e[i].UpdatedAt > e[j].UpdatedAt
	})
}

// embedItems：就地写 vec；向量服务不可用时静默跳过（Node: embed 返回 null）
func (s *Service) embedItems(ctx context.Context, eps []Episode, facts []Fact) {
	texts := []string{}
	for _, e := range eps {
		texts = append(texts, EpisodeText(e))
	}
	for _, f := range facts {
		texts = append(texts, f.Text)
	}
	if len(texts) == 0 {
		return
	}
	vecs, err := s.d.Embed(ctx, texts)
	if err != nil || vecs == nil {
		return
	}
	for i := range eps {
		eps[i].Vec = knowledge.VecToB64(vecs[i])
	}
	for i := range facts {
		facts[i].Vec = knowledge.VecToB64(vecs[len(eps)+i])
	}
}

func (s *Service) BackfillVectors(ctx context.Context) int {
	s.mu.Lock()
	var eps []Episode
	var facts []Fact
	for _, e := range s.data.Episodes {
		if e.Vec == "" {
			eps = append(eps, e)
		}
	}
	for _, f := range s.data.Facts {
		if f.Vec == "" {
			facts = append(facts, f)
		}
	}
	s.mu.Unlock()
	n := 0
	for i := 0; i < len(eps); i += 32 {
		b := eps[i:min(i+32, len(eps))]
		s.embedItems(ctx, b, nil)
		for _, e := range b {
			if e.Vec != "" {
				n++
			}
		}
	}
	for i := 0; i < len(facts); i += 32 {
		b := facts[i:min(i+32, len(facts))]
		s.embedItems(ctx, nil, b)
		for _, f := range b {
			if f.Vec != "" {
				n++
			}
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	vm := map[string]string{}
	for _, e := range eps {
		vm["e"+e.ID] = e.Vec
	}
	for _, f := range facts {
		vm["f"+f.ID] = f.Vec
	}
	for i := range s.data.Episodes {
		if v := vm["e"+s.data.Episodes[i].ID]; v != "" {
			s.data.Episodes[i].Vec = v
		}
	}
	for i := range s.data.Facts {
		if v := vm["f"+s.data.Facts[i].ID]; v != "" {
			s.data.Facts[i].Vec = v
		}
	}
	if n > 0 {
		s.persistLocked(false)
	}
	return n
}

// ---------- 召回 ----------

type Used struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"`
	Title string `json:"title"`
}

type Context struct {
	Text string `json:"text"`
	Used []Used `json:"used"`
}

func (s *Service) Context(ctx context.Context, query string) Context {
	s.mu.Lock()
	st := s.settings
	allEps := append([]Episode{}, s.data.Episodes...)
	allFacts := append([]Fact{}, s.data.Facts...)
	s.mu.Unlock()
	if !st.Enabled {
		return Context{Text: "", Used: []Used{}}
	}
	persona := s.Persona()
	facts := []Fact{}
	eps := []Episode{}
	if st.Recall && deps.Trim(query) != "" && (len(allEps) > 0 || len(allFacts) > 0) {
		hasVec := false
		for _, e := range allEps {
			hasVec = hasVec || e.Vec != ""
		}
		for _, f := range allFacts {
			hasVec = hasVec || f.Vec != ""
		}
		var qvec []float32
		if hasVec {
			if v, err := s.d.Embed(ctx, []string{deps.Slice0(query, 2000)}); err == nil && len(v) > 0 {
				qvec = v[0]
			}
		}
		hits := Recall(query, allEps, allFacts, RecallOpts{TopK: st.TopK + 2, Qvec: qvec})
		for _, h := range hits {
			if h.Kind != "episode" || len(eps) >= st.TopK {
				continue
			}
			for _, e := range allEps {
				if e.ID == h.ID {
					eps = append(eps, e)
					break
				}
			}
		}
		for _, h := range hits {
			if h.Kind != "fact" {
				continue
			}
			for _, f := range allFacts {
				if f.ID == h.ID {
					facts = append(facts, f)
					break
				}
			}
		}
	}
	for _, f := range allFacts {
		if f.Kind != "identity" || len(facts) >= 8 {
			continue
		}
		has := false
		for _, x := range facts {
			has = has || x.ID == f.ID
		}
		if !has {
			facts = append(facts, f)
		}
	}
	used := []Used{}
	for _, e := range eps {
		used = append(used, Used{e.ID, "episode", e.Title})
	}
	for _, f := range facts {
		used = append(used, Used{f.ID, "fact", f.Text})
	}
	return Context{BuildMemoryContext(persona, facts, eps), used}
}

// ---------- 浏览 / 编辑 ----------

func viewEp(e Episode) Episode {
	if e.Vec != "" {
		e.Vec = "1"
	}
	return e
}

func viewFact(f Fact) Fact {
	if f.Vec != "" {
		f.Vec = "1"
	}
	return f
}

type ListResult struct {
	Episodes []Episode `json:"episodes"`
	Facts    []Fact    `json:"facts"`
}

func (s *Service) List(filter string) ListResult {
	s.mu.Lock()
	defer s.mu.Unlock()
	q := strings.ToLower(deps.Trim(filter))
	match := func(x string) bool { return q == "" || strings.Contains(strings.ToLower(x), q) }
	eps := []Episode{}
	for _, e := range s.data.Episodes {
		if match(EpisodeText(e)) {
			eps = append(eps, e)
		}
	}
	sortEpisodes(eps)
	for i := range eps {
		eps[i] = viewEp(eps[i])
	}
	facts := []Fact{}
	for _, f := range s.data.Facts {
		if match(f.Text) {
			facts = append(facts, viewFact(f))
		}
	}
	sort.SliceStable(facts, func(i, j int) bool { return facts[i].UpdatedAt > facts[j].UpdatedAt })
	return ListResult{eps, facts}
}

func (s *Service) UpdateEpisode(ctx context.Context, id string, patch any) (Episode, error) {
	s.mu.Lock()
	idx := -1
	for i := range s.data.Episodes {
		if s.data.Episodes[i].ID == id {
			idx = i
			break
		}
	}
	if idx < 0 {
		s.mu.Unlock()
		return Episode{}, &MemError{"not-found", s.d.T("electron.common.this-memory-no-longer-exists")}
	}
	e := s.data.Episodes[idx]
	p := obj(patch)
	changed := false
	if t, ok := p["title"].(string); ok && deps.Trim(t) != "" {
		changed = changed || deps.Trim(t) != e.Title
		e.Title = deps.TrimSlice(t, 40)
	}
	if t, ok := p["summary"].(string); ok && deps.Trim(t) != "" {
		changed = changed || deps.Trim(t) != e.Summary
		e.Summary = deps.TrimSlice(t, 1200)
	}
	if arr, ok := p["keywords"].([]any); ok {
		kws := []string{}
		for _, k := range arr {
			if x := deps.Trim(deps.JSString(k)); x != "" {
				kws = append(kws, x)
			}
		}
		if len(kws) > 8 {
			kws = kws[:8]
		}
		e.Keywords = kws
	}
	if b, ok := p["pinned"].(bool); ok {
		e.Pinned = b
	}
	s.mu.Unlock()
	if changed {
		e.Edited = true
		e.UpdatedAt = s.d.Now()
		e.Vec = ""
		b := []Episode{e}
		s.embedItems(ctx, b, nil)
		e = b[0]
	}
	s.mu.Lock()
	for i := range s.data.Episodes {
		if s.data.Episodes[i].ID == id {
			s.data.Episodes[i] = e
		}
	}
	s.persistLocked(false)
	s.mu.Unlock()
	s.syncFacade()
	s.audit("memory_edit", deps.O("id", id), "ok", nil)
	return viewEp(e), nil
}

func (s *Service) UpsertFact(ctx context.Context, input any) (Fact, error) {
	o := obj(input)
	text := ""
	if t, ok := o["text"].(string); ok {
		text = deps.TrimSlice(t, 200)
	}
	if text == "" {
		return Fact{}, &MemError{"empty", s.d.T("electron.common.content-can-t-be-empty")}
	}
	kind := "note"
	if isKind(o["kind"]) {
		kind = o["kind"].(string)
	}
	now := s.d.Now()
	id, _ := o["id"].(string)
	s.mu.Lock()
	var f Fact
	found := false
	if id != "" {
		for _, x := range s.data.Facts {
			if x.ID == id {
				f, found = x, true
				break
			}
		}
	}
	if found {
		f.Text, f.Kind, f.Source, f.UpdatedAt, f.Vec = text, kind, "user", now, ""
	} else {
		f = Fact{ID: s.d.NewID(), Text: text, Kind: kind, Source: "user", CreatedAt: now, UpdatedAt: now}
		s.data.Facts = append(s.data.Facts, f)
	}
	s.mu.Unlock()
	b := []Fact{f}
	s.embedItems(ctx, nil, b)
	f = b[0]
	s.mu.Lock()
	for i := range s.data.Facts {
		if s.data.Facts[i].ID == f.ID {
			s.data.Facts[i] = f
		}
	}
	s.persistLocked(false)
	s.mu.Unlock()
	s.syncFacade()
	s.audit("memory_fact_save", deps.O("id", f.ID), "ok", nil)
	return viewFact(f), nil
}

func (s *Service) Remove(kind, id string) bool {
	s.mu.Lock()
	before := len(s.data.Episodes) + len(s.data.Facts)
	if kind == "episode" {
		out := []Episode{}
		for _, e := range s.data.Episodes {
			if e.ID != id {
				out = append(out, e)
			}
		}
		s.data.Episodes = out
	} else {
		out := []Fact{}
		for _, f := range s.data.Facts {
			if f.ID != id {
				out = append(out, f)
			}
		}
		s.data.Facts = out
		if fc := s.d.Facade(); fc != nil {
			func() { defer func() { _ = recover() }(); fc.DeleteFact(id) }()
		}
	}
	ok := len(s.data.Episodes)+len(s.data.Facts) < before
	if ok {
		s.persistLocked(false)
	}
	s.mu.Unlock()
	if ok {
		s.audit("memory_delete", deps.O("kind", kind, "id", id), "ok", nil)
	}
	return ok
}

func (s *Service) ClearAll() bool {
	s.mu.Lock()
	if fc := s.d.Facade(); fc != nil {
		for _, f := range s.data.Facts {
			func() { defer func() { _ = recover() }(); fc.DeleteFact(f.ID) }()
		}
	}
	s.data = store{V: 1, Episodes: []Episode{}, Facts: []Fact{}}
	s.persistLocked(true)
	s.mu.Unlock()
	s.audit("memory_clear", deps.O(), "ok", nil)
	return true
}

func (s *Service) Profile() (out any) {
	fc := s.d.Facade()
	if fc == nil {
		return nil
	}
	defer func() {
		if recover() != nil {
			out = nil
		}
	}()
	return fc.Profile()
}

func (s *Service) ResetProfile(ctx context.Context) (bool, error) {
	if fc := s.d.Facade(); fc != nil {
		if err := fc.ResetProfile(ctx); err != nil {
			return false, err
		}
	}
	s.audit("memory_profile_reset", deps.O(), "ok", nil)
	s.broadcast("mem.changed", nil)
	return true, nil
}

type stripEp struct {
	ID             string   `json:"id"`
	ConversationID string   `json:"conversationId"`
	Title          string   `json:"title"`
	Summary        string   `json:"summary"`
	Keywords       []string `json:"keywords"`
	CreatedAt      int64    `json:"createdAt"`
	UpdatedAt      int64    `json:"updatedAt"`
	MessageCount   int      `json:"messageCount"`
	WindowSig      string   `json:"windowSig,omitempty"`
	Pinned         bool     `json:"pinned"`
	Edited         bool     `json:"edited"`
}

type stripFact struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Text      string `json:"text"`
	Source    string `json:"source"`
	CreatedAt int64  `json:"createdAt"`
	UpdatedAt int64  `json:"updatedAt"`
	EpisodeID string `json:"episodeId,omitempty"`
}

type ExportData struct {
	Format     string      `json:"format"`
	Version    int         `json:"version"`
	ExportedAt int64       `json:"exportedAt"`
	Settings   Settings    `json:"settings"`
	Persona    string      `json:"persona"`
	Facts      []stripFact `json:"facts"`
	Episodes   []stripEp   `json:"episodes"`
	Profile    any         `json:"profile"`
}

func (s *Service) ExportData() ExportData {
	s.mu.Lock()
	d := ExportData{Format: "nomi-memory", Version: 1, ExportedAt: s.d.Now(), Settings: s.settings, Facts: []stripFact{}, Episodes: []stripEp{}}
	for _, f := range s.data.Facts {
		d.Facts = append(d.Facts, stripFact{f.ID, f.Kind, f.Text, f.Source, f.CreatedAt, f.UpdatedAt, f.EpisodeID})
	}
	for _, e := range s.data.Episodes {
		d.Episodes = append(d.Episodes, stripEp{e.ID, e.ConversationID, e.Title, e.Summary, e.Keywords, e.CreatedAt, e.UpdatedAt, e.MessageCount, e.WindowSig, e.Pinned, e.Edited})
	}
	s.mu.Unlock()
	d.Persona = s.Persona()
	d.Profile = s.Profile()
	return d
}

type ExportResult struct {
	OK   bool   `json:"ok"`
	Path string `json:"path,omitempty"`
}

func (s *Service) ExportToFile(ctx context.Context, format string) (ExportResult, error) {
	stamp := time.UnixMilli(s.d.Now()).UTC().Format("2006-01-02")
	filter := deps.FileFilter{Name: "JSON", Extensions: []string{"json"}}
	if format == "md" {
		filter = deps.FileFilter{Name: "Markdown", Extensions: []string{"md"}}
	}
	fp, err := s.d.Ports.SaveFile(ctx, s.d.T("electron.common.export-memories"), "nomi-memory-"+stamp+"."+format, []deps.FileFilter{filter})
	if err != nil {
		return ExportResult{}, err
	}
	if fp == "" {
		return ExportResult{OK: false}, nil
	}
	data := s.ExportData()
	var body string
	if format == "md" {
		s.mu.Lock()
		facts := append([]Fact{}, s.data.Facts...)
		eps := append([]Episode{}, s.data.Episodes...)
		s.mu.Unlock()
		body = ExportMarkdown(data.Persona, facts, eps, data.ExportedAt)
	} else {
		var bb []byte
		bb, err = deps.Stringify(data, "  ")
		body = string(bb)
		if err != nil {
			return ExportResult{}, err
		}
	}
	if err := os.WriteFile(fp, []byte(body), 0o600); err != nil {
		return ExportResult{}, err
	}
	h := sha1.Sum([]byte(fp))
	s.audit("memory_export", deps.O("format", format, "sha", hex.EncodeToString(h[:])[:8]), "ok", nil)
	return ExportResult{OK: true, Path: fp}, nil
}

type Stats struct {
	Episodes int `json:"episodes"`
	Facts    int `json:"facts"`
	Vectors  int `json:"vectors"`
}

type State struct {
	Settings     Settings `json:"settings"`
	Stats        Stats    `json:"stats"`
	Busy         []string `json:"busy"`
	LastError    string   `json:"lastError"`
	PersonaChars int      `json:"personaChars"`
}

func (s *Service) State() State {
	s.mu.Lock()
	st := State{Settings: s.settings, Stats: Stats{len(s.data.Episodes), len(s.data.Facts), 0}, Busy: append([]string{}, s.busy...), LastError: s.lastError}
	for _, e := range s.data.Episodes {
		if e.Vec != "" {
			st.Stats.Vectors++
		}
	}
	for _, f := range s.data.Facts {
		if f.Vec != "" {
			st.Stats.Vectors++
		}
	}
	s.mu.Unlock()
	st.PersonaChars = deps.Len16(s.Persona())
	return st
}

func (s *Service) Start() { s.syncFacade() }

// IngestFromView：只保留 user / assistant 的字符串消息，每条截到 6000 字
func (s *Service) IngestFromView(ctx context.Context, conversationID string, history any, force bool) (IngestResult, error) {
	msgs := []TurnMsg{}
	if arr, ok := history.([]any); ok {
		for _, x := range arr {
			m, ok := x.(map[string]any)
			if !ok {
				continue
			}
			r, _ := m["role"].(string)
			c, isStr := m["content"].(string)
			if (r == "user" || r == "assistant") && isStr {
				msgs = append(msgs, TurnMsg{r, deps.Slice0(c, 6000)})
			}
		}
	}
	return s.Ingest(ctx, conversationID, msgs, force)
}

func (s *Service) audit(tool string, args any, result string, ms *int64) {
	if s.d.Desktop == nil {
		return
	}
	defer func() { _ = recover() }()
	s.d.Desktop.Append(deps.AuditEntry{Tool: tool, Args: args, Decision: "user", Result: result, Ms: ms, Source: "memory"})
}

func (s *Service) broadcast(ch string, payload any) {
	if s.d.Events != nil {
		s.d.Events.Publish(ch, payload)
	}
}

func msgHash(m TurnMsg) string {
	h := sha1.Sum([]byte(m.Role + "\x00" + m.Content))
	return hex.EncodeToString(h[:])
}

func windowSig(all []TurnMsg, end int, hashes []string) string {
	from := max(0, end-summaryWindow+1)
	h := sha1.New()
	for i := from; i <= end; i++ {
		if hashes != nil {
			h.Write([]byte(hashes[i]))
		} else {
			h.Write([]byte(msgHash(all[i])))
		}
	}
	return hex.EncodeToString(h.Sum(nil))
}

const inf = int(^uint(0) >> 1)

func newSinceLast(all []TurnMsg, prev Episode) int {
	if prev.WindowSig == "" {
		added := len(all) - prev.MessageCount
		if added < 0 || len(all) >= historyCap {
			return inf
		}
		return added
	}
	hashes := make([]string, len(all))
	for i, m := range all {
		hashes[i] = msgHash(m)
	}
	stop := max(0, len(all)-1-resyncLookback)
	for end := len(all) - 1; end >= stop; end-- {
		if windowSig(all, end, hashes) == prev.WindowSig {
			return len(all) - 1 - end
		}
	}
	return inf
}
