package knowledge

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
	dparse "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop/parse"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	gnet "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/net"
	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

const (
	MaxFilesPerSource = 20_000
	MaxDepth          = 12
	MaxFileBytes      = 30 * 1024 * 1024
	EmbedBatch        = 32
)

var skipDirs = map[string]bool{"node_modules": true, "__pycache__": true, "venv": true, ".venv": true, "dist": true, "build": true, "target": true}

var textExts = map[string]bool{}
var docExts = map[string]bool{"pdf": true, "docx": true, "odt": true, "rtf": true, "xlsx": true}

func init() {
	for _, e := range strings.Fields("txt md markdown csv tsv json log yaml yml toml ini xml html htm ts tsx js jsx mjs cjs py rb go rs java kt c h cpp hpp cs swift php sh sql css scss vue svelte tex rst org") {
		textExts[e] = true
	}
}

var extRe = regexp.MustCompile(`\.([A-Za-z0-9]+)$`)

// ExtOf / IsSupported：desktop/parse/extract
func ExtOf(p string) string {
	m := extRe.FindStringSubmatch(p)
	if m == nil {
		return ""
	}
	return strings.ToLower(m[1])
}

func IsSupported(p string) bool { e := ExtOf(p); return textExts[e] || docExts[e] }

// IsLocalBaseURL：desktop/consent.isLocalBaseURL
func IsLocalBaseURL(baseURL string) bool {
	if baseURL == "" {
		return false
	}
	u, err := gnet.ParseURL(baseURL)
	if err != nil {
		return false
	}
	h := strings.ToLower(u.Hostname())
	h = strings.TrimSuffix(strings.TrimPrefix(h, "["), "]")
	return h == "localhost" || h == "::1" || strings.HasPrefix(h, "127.") || strings.HasSuffix(h, ".local") || h == "0.0.0.0"
}

// KbError：契约层映射为 KB_<CODE>
type KbError struct{ Code, Msg string }

func (e *KbError) Error() string { return e.Msg }

type Provider struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	BaseURL string `json:"baseURL"`
}

type Credentials struct {
	Provider
	APIKey string
}

type ChatProvider struct {
	ID    string
	Name  string
	Local bool
}

// ParseResult / ParseFunc：desktop/parse 的 parseFile（受限子进程解析），默认就用它（同 Node）
type ParseResult struct {
	OK        bool
	Text      string
	PageTexts []string
	Message   string
}

type ParseFunc func(ctx context.Context, path string) ParseResult

// OcrFunc：图片 OCR。Node 版在主进程跑 tesseract.js；Go 版还没有 OCR 实现，不注入时图片索引失败（OCR unavailable）。
type OcrFunc func(ctx context.Context, path string, langs []string, langDir string) (string, error)

type Deps struct {
	Root          string
	Logger        deps.Logger
	Desktop       deps.Desktop
	ListProviders func() []Provider            // aiRuntime.listProviders
	Credentials   func(id string) *Credentials // aiRuntime.providerCredentials
	Complete      deps.CompleteFunc
	ChatProvider  func() *ChatProvider // desktop.providerFor('chat')
	Ports         deps.Ports
	Events        deps.Events
	T             i18n.Translate
	Parse         ParseFunc
	Ocr           OcrFunc
	Download      Downloader
	Now           func() int64
	NewID         func() string
}

type KbProgress struct {
	Running bool   `json:"running"`
	Phase   string `json:"phase"`
	Done    int    `json:"done"`
	Total   int    `json:"total"`
	Current string `json:"current,omitempty"`
	Added   int    `json:"added"`
	Updated int    `json:"updated"`
	Removed int    `json:"removed"`
	Failed  int    `json:"failed"`
	Error   string `json:"error,omitempty"`
}

type dl struct {
	cancel   context.CancelFunc
	received int64
	total    int64
}

type Service struct {
	d        Deps
	Index    *KnowledgeIndex
	mu       sync.Mutex
	settings KbSettings
	job      *struct {
		cancel context.CancelFunc
		ctx    context.Context
		p      *KbProgress
	}
	last      KbProgress
	downloads map[string]*dl
	started   bool
	stop      chan struct{}
	offBroker func()
}

func DocIDOf(p string) string {
	h := sha1.Sum([]byte(p))
	return hex.EncodeToString(h[:])[:16]
}

func New(d Deps) *Service {
	if d.T == nil {
		d.T = i18n.Identity
	}
	if d.Logger == nil {
		d.Logger = deps.StdLogger{Prefix: "[kb]"}
	}
	if d.Now == nil {
		d.Now = func() int64 { return time.Now().UnixMilli() }
	}
	if d.NewID == nil {
		d.NewID = deps.RandomUUID
	}
	if d.Complete == nil {
		d.Complete = deps.UnavailableComplete
	}
	if d.ListProviders == nil {
		d.ListProviders = func() []Provider { return []Provider{} }
	}
	if d.Credentials == nil {
		d.Credentials = func(string) *Credentials { return nil }
	}
	if d.ChatProvider == nil {
		d.ChatProvider = func() *ChatProvider { return nil }
	}
	if d.Download == nil {
		d.Download = DownloadVerified
	}
	if d.Parse == nil {
		d.Parse = parseFile
	}
	s := &Service{d: d, downloads: map[string]*dl{}, last: KbProgress{Phase: "idle"}}
	s.settings = s.load()
	s.Index = NewIndex(filepath.Join(d.Root, "index.json"))
	return s
}

func (s *Service) settingsFile() string { return filepath.Join(s.d.Root, "settings.json") }
func (s *Service) ocrDir() string       { return filepath.Join(s.d.Root, "ocr") }
func (s *Service) broker() deps.Broker  { return s.d.Desktop.Broker() }

func readJSON(p string) (any, error) {
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	return deps.ParseJSON(b)
}

func (s *Service) load() KbSettings {
	v, err := readJSON(s.settingsFile())
	if err != nil {
		return DefaultKbSettings()
	}
	return SanitizeKbSettings(v)
}

func (s *Service) saveLocked() {
	_ = os.MkdirAll(s.d.Root, 0o755)
	if b, err := deps.Stringify(s.settings, "  "); err == nil {
		_ = os.WriteFile(s.settingsFile(), b, 0o600)
	}
	s.broadcast("kb.changed", nil)
}

func (s *Service) GetSettings() KbSettings {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.settings
}

func embedKey(r KbModelRef) string {
	b := "false"
	if r.Enabled {
		b = "true"
	}
	return b + "|" + r.ProviderID + "|" + r.Model
}

func toMap(v any) map[string]any {
	b, _ := deps.Stringify(v, "")
	m, _ := deps.ParseJSON(b)
	if mm, ok := m.(map[string]any); ok {
		return mm
	}
	return map[string]any{}
}

func (s *Service) SetSettings(patch any) KbSettings {
	s.mu.Lock()
	merged := toMap(s.settings)
	for k, v := range obj(patch) {
		merged[k] = v
	}
	cur := toMap(s.settings)
	merged["sources"], merged["cloudConsent"] = cur["sources"], cur["cloudConsent"]
	prev := embedKey(s.settings.Embed)
	s.settings = SanitizeKbSettings(merged)
	s.saveLocked()
	st := s.settings
	s.mu.Unlock()
	if prev != embedKey(st.Embed) && st.Embed.Enabled {
		go s.Reindex(context.Background(), nil, false)
	}
	return st
}

func (s *Service) ConsentCloud(providerID string) bool {
	found := false
	for _, p := range s.d.ListProviders() {
		if p.ID == providerID {
			found = true
		}
	}
	if !found {
		return false
	}
	s.mu.Lock()
	for _, c := range s.settings.CloudConsent {
		if c == providerID {
			s.mu.Unlock()
			return true
		}
	}
	s.settings.CloudConsent = append(s.settings.CloudConsent, providerID)
	s.saveLocked()
	s.mu.Unlock()
	s.audit("kb_cloud_consent", deps.O("provider", providerID), "user", "ok", nil, "", "settings")
	return true
}

// ---------- 来源 ----------

func (s *Service) AddFolder(ctx context.Context) (*KbSource, error) {
	picked, err := s.d.Ports.PickDirectory(ctx, s.d.T("electron.common.choose-a-folder-to-add-to-the-knowledge"), s.d.T("electron.common.add-to-knowledge-base"))
	if err != nil || picked == "" {
		return nil, nil
	}
	src, err := s.AddFolderPath(ctx, picked)
	if err != nil {
		return nil, err
	}
	return &src, nil
}

func (s *Service) AddFolderPath(ctx context.Context, picked string) (KbSource, error) {
	b := s.broker()
	if !b.Guard(ctx, picked, "read").OK {
		abs, _ := filepath.Abs(picked)
		b.Grant(abs)
	}
	g := b.Guard(ctx, picked, "read")
	if !g.OK {
		m := g.Message
		if m == "" {
			m = g.Code
		}
		return KbSource{}, &KbError{"denied", s.d.T("electron.common.this-folder-can-t-be-added-to-the", m)}
	}
	s.mu.Lock()
	for _, x := range s.settings.Sources {
		if x.Kind == "folder" && x.Path == g.Real {
			s.mu.Unlock()
			return x, nil
		}
	}
	src := KbSource{ID: s.d.NewID(), Kind: "folder", Path: g.Real, AddedAt: float64(s.d.Now()), Enabled: true}
	s.settings.Sources = append(s.settings.Sources, src)
	s.saveLocked()
	s.mu.Unlock()
	s.audit("kb_add_source", deps.O("path", g.Real), "user", "ok", nil, "", "settings")
	go s.Reindex(context.Background(), []string{src.ID}, false)
	return src, nil
}

func (s *Service) RemoveSource(id string) bool {
	s.mu.Lock()
	i := -1
	for j, x := range s.settings.Sources {
		if x.ID == id {
			i = j
		}
	}
	if i < 0 {
		s.mu.Unlock()
		return false
	}
	src := s.settings.Sources[i]
	s.settings.Sources = append(s.settings.Sources[:i:i], s.settings.Sources[i+1:]...)
	s.Index.RemoveSource(id)
	_ = s.Index.Save()
	s.saveLocked()
	s.mu.Unlock()
	s.audit("kb_remove_source", deps.O("path", src.Path), "user", "ok", nil, "", "settings")
	return true
}

func (s *Service) SetSourceEnabled(id string, enabled bool) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.settings.Sources {
		if s.settings.Sources[i].ID == id {
			s.settings.Sources[i].Enabled = enabled
			s.saveLocked()
			return true
		}
	}
	return false
}

// ---------- OCR 资源 ----------

func (s *Service) OcrAssetPath(a OcrAsset) string { return filepath.Join(s.ocrDir(), a.FileName) }

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

func (s *Service) OcrLangsReady() []string {
	s.mu.Lock()
	langs := append([]string{}, s.settings.Ocr.Langs...)
	s.mu.Unlock()
	out := []string{}
	for _, l := range langs {
		for _, a := range OcrAssets {
			if a.Lang == l && exists(s.OcrAssetPath(a)) {
				out = append(out, l)
				break
			}
		}
	}
	return out
}

type OkErr struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

func findAsset(id string) *OcrAsset {
	for i := range OcrAssets {
		if OcrAssets[i].ID == id {
			return &OcrAssets[i]
		}
	}
	return nil
}

func (s *Service) DownloadOcr(ctx context.Context, id string) OkErr {
	a := findAsset(id)
	if a == nil {
		return OkErr{false, s.d.T("electron.common.unknown-resource")}
	}
	s.mu.Lock()
	if s.downloads[id] != nil {
		s.mu.Unlock()
		return OkErr{false, s.d.T("electron.common.downloading")}
	}
	cctx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	rec := &dl{cancel: cancel, total: a.Bytes}
	s.downloads[id] = rec
	s.mu.Unlock()
	emit := func(phase, errMsg string) {
		s.mu.Lock()
		p := map[string]any{"id": id, "received": rec.received, "total": rec.total, "phase": phase}
		s.mu.Unlock()
		if errMsg != "" {
			p["error"] = errMsg
		}
		s.broadcast("kb.download", p)
	}
	defer func() {
		cancel()
		s.mu.Lock()
		delete(s.downloads, id)
		s.mu.Unlock()
		s.broadcast("kb.changed", nil)
	}()
	emit("start", "")
	err := s.d.Download(cctx, a.URL, a.Sha256, s.OcrAssetPath(*a), a.Bytes, func(r, t int64) {
		s.mu.Lock()
		rec.received = r
		if t == 0 {
			t = a.Bytes
		}
		rec.total = t
		s.mu.Unlock()
		emit("progress", "")
	})
	if err == nil {
		s.audit("kb_ocr_download", deps.O("id", id), "user", "ok", nil, "", "settings")
		emit("done", "")
		return OkErr{OK: true}
	}
	aborted := cctx.Err() != nil
	msg := err.Error()
	phase := "error"
	if aborted {
		msg, phase = s.d.T("electron.common.cancelled"), "cancelled"
	}
	emit(phase, msg)
	return OkErr{false, msg}
}

func (s *Service) CancelOcr(id string) bool {
	s.mu.Lock()
	d := s.downloads[id]
	s.mu.Unlock()
	if d != nil {
		d.cancel()
	}
	return d != nil
}

func (s *Service) RemoveOcr(id string) bool {
	a := findAsset(id)
	if a == nil {
		return false
	}
	_ = os.Remove(s.OcrAssetPath(*a))
	s.broadcast("kb.changed", nil)
	return true
}

func (s *Service) OCR(ctx context.Context, file string) (string, error) {
	langs := s.OcrLangsReady()
	if len(langs) == 0 {
		return "", &KbError{"ocr_missing", s.d.T("electron.common.ocr-language-data-not-downloaded-yet")}
	}
	if s.d.Ocr == nil {
		return "", errors.New("OCR unavailable")
	}
	return s.d.Ocr(ctx, file, langs, s.ocrDir())
}

// ---------- 模型端点 ----------

type endpointX struct {
	Endpoint
	local bool
	name  string
}

func (s *Service) endpoint(ref KbModelRef) *endpointX {
	if !ref.Enabled || ref.ProviderID == "" || ref.Model == "" {
		return nil
	}
	c := s.d.Credentials(ref.ProviderID)
	if c == nil {
		return nil
	}
	return &endpointX{Endpoint{c.BaseURL, c.APIKey, ref.Model}, IsLocalBaseURL(c.BaseURL), c.Name}
}

func (s *Service) allowRemote(ep *endpointX, providerID string) string {
	if ep.local {
		return ""
	}
	if s.broker().LocalOnly() {
		return s.d.T("electron.common.only-local-models-wont-send-to", ep.name)
	}
	s.mu.Lock()
	consent := append([]string{}, s.settings.CloudConsent...)
	s.mu.Unlock()
	for _, c := range consent {
		if c == providerID {
			return ""
		}
	}
	return s.d.T("electron.common.you-haven-t-agreed-to-send-file-chunks", ep.name)
}

func (s *Service) embedEndpoint() *endpointX {
	st := s.GetSettings()
	ep := s.endpoint(st.Embed)
	if ep == nil || s.allowRemote(ep, st.Embed.ProviderID) != "" {
		return nil
	}
	return ep
}

// EmbedTexts：供长期记忆复用同一向量服务；未启用 / 未同意云端时返回 nil
func (s *Service) EmbedTexts(ctx context.Context, texts []string) [][]float32 {
	ep := s.embedEndpoint()
	if ep == nil || len(texts) == 0 {
		return nil
	}
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	v, err := Embed(cctx, nil, s.d.T, ep.Endpoint, texts)
	if err != nil {
		s.d.Logger.Warn("embedTexts failed", err.Error())
		return nil
	}
	return v
}

type EmbedStatus struct {
	Active bool   `json:"active"`
	Reason string `json:"reason,omitempty"`
}

func (s *Service) EmbedStatus() EmbedStatus {
	st := s.GetSettings()
	if !st.Embed.Enabled {
		return EmbedStatus{}
	}
	ep := s.endpoint(st.Embed)
	if ep == nil {
		return EmbedStatus{false, s.d.T("electron.common.please-choose-a-service-and-model")}
	}
	if r := s.allowRemote(ep, st.Embed.ProviderID); r != "" {
		return EmbedStatus{false, r}
	}
	return EmbedStatus{Active: true}
}

type OkMsg struct {
	OK      bool   `json:"ok"`
	Message string `json:"message"`
}

func (s *Service) TestEndpoint(ctx context.Context, kind string) OkMsg {
	st := s.GetSettings()
	ref := st.Rerank
	if kind == "embed" {
		ref = st.Embed
	}
	ref.Enabled = true
	ep := s.endpoint(ref)
	T := s.d.T
	if ep == nil {
		return OkMsg{false, T("electron.common.please-choose-a-service-and-model-first")}
	}
	if why := s.allowRemote(ep, ref.ProviderID); why != "" {
		return OkMsg{false, why}
	}
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if kind == "embed" {
		v, err := Embed(cctx, nil, T, ep.Endpoint, []string{T("electron.common.connection-test")})
		if err != nil {
			return OkMsg{false, err.Error()}
		}
		return OkMsg{true, T("electron.common.connected-embedding-dimension", len(v[0]))}
	}
	sc, err := Rerank(cctx, nil, T, ep.Endpoint, T("electron.common.test"), []string{T("electron.common.apple"), T("electron.common.banana")})
	if err != nil {
		return OkMsg{false, err.Error()}
	}
	return OkMsg{true, T("electron.common.connected-scores", len(sc))}
}

// ---------- 索引 ----------

func (s *Service) Progress() KbProgress {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.job != nil {
		return *s.job.p
	}
	return s.last
}

func (s *Service) CancelIndex() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.job != nil {
		s.job.cancel()
	}
	return s.job != nil
}

func (s *Service) emitProgress() { s.broadcast("kb.progress", s.Progress()) }

func (s *Service) walk(ctx context.Context, root string, out *[]string) {
	st := s.GetSettings()
	ocrOk := st.Ocr.Enabled && len(s.OcrLangsReady()) > 0
	var visit func(dir string, depth int)
	visit = func(dir string, depth int) {
		if depth > MaxDepth || len(*out) >= MaxFilesPerSource || ctx.Err() != nil {
			return
		}
		items, _ := os.ReadDir(dir) // 按名字排序；Node readdir 为文件系统顺序（见 D-B8 偏差表）
		for _, it := range items {
			if len(*out) >= MaxFilesPerSource || ctx.Err() != nil {
				return
			}
			name := it.Name()
			if strings.HasPrefix(name, ".") || it.Type()&os.ModeSymlink != 0 {
				continue
			}
			full := filepath.Join(dir, name)
			if it.IsDir() {
				if !skipDirs[name] {
					visit(full, depth+1)
				}
			} else if it.Type().IsRegular() {
				e := ExtOf(full)
				if IsSupported(full) || (ocrOk && ImageExts[e]) {
					*out = append(*out, full)
				}
			}
		}
	}
	visit(root, 0)
}

// Reindex：增量重建索引；ids 为 nil = 全部启用的来源
func (s *Service) Reindex(parent context.Context, ids []string, force bool) KbProgress {
	return s.reindex(parent, ids, force, func() {})
}

// reindex：ready 在 job 登记后（或直接返回前）调用
func (s *Service) reindex(parent context.Context, ids []string, force bool, ready func()) KbProgress {
	s.mu.Lock()
	if s.job != nil {
		p := *s.job.p
		s.mu.Unlock()
		ready()
		return p
	}
	anyEnabled := false
	for _, x := range s.settings.Sources {
		anyEnabled = anyEnabled || x.Enabled
	}
	if !anyEnabled && len(s.Index.List()) == 0 {
		s.mu.Unlock()
		ready()
		return s.Progress()
	}
	ctx, cancel := context.WithCancel(context.WithoutCancel(parent))
	p := &KbProgress{Running: true, Phase: "scan"}
	s.job = &struct {
		cancel context.CancelFunc
		ctx    context.Context
		p      *KbProgress
	}{cancel, ctx, p}
	settings := s.settings
	s.mu.Unlock()
	ready()
	s.emitProgress()
	started := s.d.Now()
	// p 的修改在 s.mu 下进行，Progress() 才能并发读
	upd := func(fn func()) { s.mu.Lock(); fn(); s.mu.Unlock() }
	func() {
		type work struct {
			src  KbSource
			file string
		}
		var ws []work
		for _, src := range settings.Sources {
			if !src.Enabled || (ids != nil && !contains(ids, src.ID)) {
				continue
			}
			seen := map[string]bool{}
			if src.Path != "" {
				g := s.broker().Guard(ctx, src.Path, "read")
				if !g.OK {
					n := s.Index.RemoveSource(src.ID)
					upd(func() { p.Removed += n })
					continue
				}
				var files []string
				s.walk(ctx, g.Real, &files)
				for _, f := range files {
					seen[DocIDOf(f)] = true
					ws = append(ws, work{src, f})
				}
			}
			for _, d := range s.Index.BySource(src.ID) {
				if !seen[d.ID] {
					s.Index.Remove(d.ID)
					upd(func() { p.Removed++ })
				}
			}
		}
		live := map[string]bool{}
		for _, x := range s.GetSettings().Sources {
			live[x.ID] = true
		}
		for _, d := range s.Index.List() {
			if !live[d.SourceID] {
				s.Index.Remove(d.ID)
			}
		}
		upd(func() { p.Phase, p.Total = "index", len(ws) })
		s.emitProgress()
		ep := s.embedEndpoint()
		embedModel := ""
		if ep != nil {
			embedModel = settings.Embed.ProviderID + ":" + ep.Model
		}
		var lastEmit int64
		for _, w := range ws {
			if ctx.Err() != nil {
				break
			}
			upd(func() { p.Current = filepath.Base(w.file) })
			r, err := s.indexFile(ctx, w.src, w.file, embedModel, ep, force)
			if err != nil {
				if ctx.Err() != nil {
					break
				}
				upd(func() { p.Failed++ })
				s.d.Logger.Warn("知识库：索引文件失败", "file", w.file, "error", err.Error())
			} else {
				upd(func() {
					switch r {
					case "added":
						p.Added++
					case "updated":
						p.Updated++
					case "failed":
						p.Failed++
					}
				})
			}
			var done int
			upd(func() { p.Done++; done = p.Done })
			if now := time.Now().UnixMilli(); now-lastEmit > 200 {
				lastEmit = now
				s.emitProgress()
			}
			if done%50 == 0 {
				_ = s.Index.Save()
			}
		}
		upd(func() {
			if ctx.Err() != nil {
				p.Phase = "cancelled"
			} else {
				p.Phase = "done"
			}
		})
	}()
	_ = s.Index.Save()
	cancel()
	s.mu.Lock()
	p.Running = false
	p.Current = ""
	s.last = *p
	s.job = nil
	fin := *p
	s.mu.Unlock()
	s.emitProgress()
	s.broadcast("kb.changed", nil)
	result := "ok"
	if fin.Phase == "error" {
		result = "error"
	}
	ms := s.d.Now() - started
	s.audit("kb_index", deps.O("added", fin.Added, "updated", fin.Updated, "removed", fin.Removed, "failed", fin.Failed), "auto", result, &ms, "", "settings")
	return s.Progress()
}

func contains(xs []string, v string) bool {
	for _, x := range xs {
		if x == v {
			return true
		}
	}
	return false
}

func (s *Service) withVectors(ctx context.Context, chunks []Chunk, docID, title string, ep *endpointX) ([]*ChunkRec, error) {
	out := make([]*ChunkRec, len(chunks))
	for i, c := range chunks {
		out[i] = &ChunkRec{ID: docID + ":" + itoa(i), Text: c.Text, Page: c.Page, Offset: c.Offset}
	}
	if ep == nil || len(out) == 0 {
		return out, nil
	}
	for i := 0; i < len(out); i += EmbedBatch {
		batch := out[i:min(i+EmbedBatch, len(out))]
		in := make([]string, len(batch))
		for j, c := range batch {
			in[j] = title + "\n" + c.Text
		}
		vecs, err := Embed(ctx, nil, s.d.T, ep.Endpoint, in)
		if err != nil {
			return nil, err
		}
		for j, c := range batch {
			c.Vec = VecToB64(vecs[j])
		}
	}
	return out, nil
}

func (s *Service) indexFile(ctx context.Context, src KbSource, file, embedModel string, ep *endpointX, force bool) (string, error) {
	id := DocIDOf(file)
	g := s.broker().Guard(ctx, file, "read")
	if !g.OK {
		s.Index.Remove(id)
		return "same", nil
	}
	st, err := os.Stat(g.Real)
	if err != nil {
		return "", err
	}
	mtime := float64(st.ModTime().UnixNano()) / 1e6
	prev, hasPrev := s.Index.Get(id)
	if !force && hasPrev && prev.Mtime == mtime && prev.Size == st.Size() && prev.EmbedModel == embedModel {
		return "same", nil
	}
	ext := ExtOf(file)
	base := DocRec{ID: id, SourceID: src.ID, Path: g.Real, Title: filepath.Base(g.Real), Ext: ext, Mtime: mtime, Size: st.Size(), IndexedAt: s.d.Now()}
	if st.Size() > MaxFileBytes {
		d := base
		d.Status, d.Error, d.Chunks = "error", s.d.T("electron.common.file-too-large-30mb"), []*ChunkRec{}
		s.Index.Put(&d)
		return "failed", nil
	}
	var chunks []Chunk
	ocr := false
	if ImageExts[ext] {
		text, err := s.OCR(ctx, g.Real)
		if err != nil {
			return "", err
		}
		chunks, ocr = ChunkText(text, 800, 120, 0), true
	} else {
		r := s.d.Parse(ctx, g.Real)
		if !r.OK {
			d := base
			d.Status, d.Error, d.Chunks = "error", r.Message, []*ChunkRec{}
			s.Index.Put(&d)
			return "failed", nil
		}
		if r.PageTexts != nil {
			chunks = ChunkPages(r.PageTexts, 800, 120)
		} else {
			chunks = ChunkText(r.Text, 800, 120, 0)
		}
	}
	withVec, err := s.withVectors(ctx, chunks, id, base.Title, ep)
	if err != nil {
		return "", err
	}
	if !s.broker().Guard(ctx, file, "read").OK {
		s.Index.Remove(id)
		return "same", nil
	}
	d := base
	d.Status = "empty"
	if len(withVec) > 0 {
		d.Status = "ok"
		d.EmbedModel = embedModel
	}
	d.Ocr, d.Chunks = ocr, withVec
	s.Index.Put(&d)
	if hasPrev {
		return "updated", nil
	}
	return "added", nil
}

// ---------- 检索 / 问答 ----------

func (s *Service) enabledSourceIDs() []string {
	out := []string{}
	for _, x := range s.GetSettings().Sources {
		if x.Enabled {
			out = append(out, x.ID)
		}
	}
	return out
}

func (s *Service) revokedSourceIDs(ctx context.Context, ids []string) map[string]bool {
	revoked := map[string]bool{}
	srcs := s.GetSettings().Sources
	for _, id := range ids {
		for _, x := range srcs {
			if x.ID == id && x.Path != "" && !s.broker().Guard(ctx, x.Path, "read").OK {
				revoked[id] = true
			}
		}
	}
	return revoked
}

func (s *Service) pruneRevoked(ctx context.Context) {
	var all []string
	for _, x := range s.GetSettings().Sources {
		all = append(all, x.ID)
	}
	removed := 0
	for id := range s.revokedSourceIDs(ctx, all) {
		removed += s.Index.RemoveSource(id)
	}
	if removed > 0 {
		_ = s.Index.Save()
		s.broadcast("kb.changed", nil)
	}
}

type SearchResult struct {
	Hits []Hit  `json:"hits"`
	Mode string `json:"mode"`
}

// Search：limit<=0 时取 settings.topK
func (s *Service) Search(ctx context.Context, query string, limit int) SearchResult {
	st := s.GetSettings()
	if limit <= 0 {
		limit = st.TopK
	}
	q := deps.TrimSlice(query, 1000)
	if q == "" {
		return SearchResult{[]Hit{}, "bm25"}
	}
	var qv []float32
	modes := []string{"BM25"}
	ep := s.embedEndpoint()
	if ep != nil {
		v, err := Embed(ctx, nil, s.d.T, ep.Endpoint, []string{q})
		if err == nil {
			qv = v[0]
			modes = append(modes, s.d.T("electron.common.vector"))
		} else {
			s.d.Logger.Warn("知识库：查询向量失败，只用 BM25", "error", err.Error())
		}
	}
	embedModel := ""
	if ep != nil {
		embedModel = st.Embed.ProviderID + ":" + ep.Model
	}
	rr := s.endpoint(st.Rerank)
	useRerank := rr != nil && s.allowRemote(rr, st.Rerank.ProviderID) == ""
	enabled := s.enabledSourceIDs()
	revoked := s.revokedSourceIDs(ctx, enabled)
	if len(revoked) > 0 {
		go s.pruneRevoked(context.Background())
	}
	allowed := []string{}
	for _, id := range enabled {
		if !revoked[id] {
			allowed = append(allowed, id)
		}
	}
	lim := limit
	if useRerank {
		lim = max(limit*3, 15)
	}
	hits := s.Index.Search(q, SearchOpts{Limit: lim, QueryVec: qv, EmbedModel: embedModel, SourceIDs: allowed, HasSources: true})
	if useRerank && len(hits) > 1 {
		docs := make([]string, len(hits))
		for i, h := range hits {
			docs[i] = h.Text
		}
		sc, err := Rerank(ctx, nil, s.d.T, rr.Endpoint, q, docs)
		if err == nil {
			for i := range hits {
				hits[i].Score = sc[i]
			}
			sort.SliceStable(hits, func(i, j int) bool { return hits[i].Score > hits[j].Score })
			modes = append(modes, s.d.T("electron.common.rerank"))
		} else {
			s.d.Logger.Warn("知识库：重排失败，使用融合排序", "error", err.Error())
		}
	}
	if len(hits) > limit {
		hits = hits[:limit]
	}
	return SearchResult{hits, strings.Join(modes, " + ")}
}

type AskResult struct {
	Answer  string      `json:"answer"`
	Sources []SourceRef `json:"sources"`
	Mode    string      `json:"mode"`
}

func (s *Service) Ask(ctx context.Context, question string, history []deps.Msg) (AskResult, error) {
	started := s.d.Now()
	T := s.d.T
	if s.Index.Stats().Chunks == 0 {
		return AskResult{}, &KbError{"empty", T("electron.common.the-knowledge-base-is-empty-add-folders")}
	}
	r := s.Search(ctx, question, 0)
	if len(r.Hits) == 0 {
		return AskResult{T("electron.common.nothing-relevant-found-in-the-knowledge-base-try"), []SourceRef{}, r.Mode}, nil
	}
	var target *deps.SendTarget
	pid := ""
	if cp := s.d.ChatProvider(); cp != nil {
		target = &deps.SendTarget{ID: cp.ID, Name: cp.Name, Local: cp.Local}
		pid = cp.ID
	}
	switch s.broker().CheckSend(ctx, target) {
	case "local_only":
		return AskResult{}, &KbError{"local_only", T("electron.common.only-local-models-cloud-chat-no-kb")}
	case "user_denied":
		return AskResult{}, &KbError{"user_denied", T("electron.common.ok-knowledge-base-content-won-t-be-sent")}
	}
	deps.AvatarGesture(s.d.Events, "think")
	out, err := s.d.Complete(ctx, BuildAskMessages(question, r.Hits, history))
	if err != nil {
		return AskResult{}, err
	}
	answer := deps.Trim(out)
	sources := ToSources(r.Hits, answer)
	if len(sources) > 0 {
		deps.AvatarGesture(s.d.Events, "nod")
	} else {
		deps.AvatarGesture(s.d.Events, "shakeHead")
	}
	ms := s.d.Now() - started
	s.audit("kb_ask", deps.O("question", deps.Slice0(question, 80), "sources", len(sources)), "auto", "ok", &ms, pid, "agent")
	return AskResult{answer, sources, r.Mode}, nil
}

// AskFromView：只保留 user / assistant 的文本消息，每条截到 4000 字
func (s *Service) AskFromView(ctx context.Context, question string, history any) (AskResult, error) {
	h := []deps.Msg{}
	if arr, ok := history.([]any); ok {
		for _, x := range arr {
			m, ok := x.(map[string]any)
			if !ok {
				continue
			}
			role, _ := m["role"].(string)
			c, isStr := m["content"].(string)
			if (role == "user" || role == "assistant") && isStr {
				h = append(h, deps.Msg{Role: role, Content: deps.Slice0(c, 4000)})
			}
		}
	}
	return s.Ask(ctx, question, h)
}

func (s *Service) Open(ctx context.Context, docID, how string) OkErr {
	d, ok := s.Index.Get(docID)
	if !ok {
		return OkErr{false, s.d.T("electron.common.source-is-no-longer-in-the-index")}
	}
	g := s.broker().Guard(ctx, d.Path, "read")
	if !g.OK {
		return OkErr{false, s.d.T("electron.common.this-file-is-no-longer-within-the-granted")}
	}
	if how == "reveal" {
		s.d.Ports.ShowItemInFolder(g.Real)
		return OkErr{OK: true}
	}
	if err := s.d.Ports.OpenPath(g.Real); err != "" {
		return OkErr{false, err}
	}
	return OkErr{OK: true}
}

// ---------- 状态 ----------

type SourceStat struct {
	KbSource
	Docs        int   `json:"docs"`
	Chunks      int   `json:"chunks"`
	Errors      int   `json:"errors"`
	LastIndexed int64 `json:"lastIndexed"`
}

type ProviderX struct {
	Provider
	Local bool `json:"local"`
}

type OcrState struct {
	OcrAsset
	Installed   bool        `json:"installed"`
	Downloading *DlProgress `json:"downloading"`
}

type DlProgress struct {
	Received int64 `json:"received"`
	Total    int64 `json:"total"`
}

type KbState struct {
	Settings    KbSettings   `json:"settings"`
	Sources     []SourceStat `json:"sources"`
	Stats       IndexStats   `json:"stats"`
	Progress    KbProgress   `json:"progress"`
	EmbedStatus EmbedStatus  `json:"embedStatus"`
	LocalOnly   bool         `json:"localOnly"`
	Providers   []ProviderX  `json:"providers"`
	Ocr         []OcrState   `json:"ocr"`
}

func (s *Service) State() KbState {
	by := map[string]*SourceStat{}
	for _, d := range s.Index.List() {
		x := by[d.SourceID]
		if x == nil {
			x = &SourceStat{}
			by[d.SourceID] = x
		}
		x.Docs++
		x.Chunks += len(d.Chunks)
		if d.Status == "error" {
			x.Errors++
		}
		x.LastIndexed = max(x.LastIndexed, d.IndexedAt)
	}
	st := s.GetSettings()
	out := KbState{Settings: st, Sources: []SourceStat{}, Stats: s.Index.Stats(), Progress: s.Progress(),
		EmbedStatus: s.EmbedStatus(), LocalOnly: s.broker().LocalOnly(), Providers: []ProviderX{}, Ocr: []OcrState{}}
	for _, src := range st.Sources {
		x := SourceStat{}
		if b := by[src.ID]; b != nil {
			x = *b
		}
		x.KbSource = src
		out.Sources = append(out.Sources, x)
	}
	for _, p := range s.d.ListProviders() {
		out.Providers = append(out.Providers, ProviderX{p, IsLocalBaseURL(p.BaseURL)})
	}
	for _, a := range OcrAssets {
		o := OcrState{OcrAsset: a, Installed: exists(s.OcrAssetPath(a))}
		s.mu.Lock()
		if d := s.downloads[a.ID]; d != nil {
			o.Downloading = &DlProgress{d.received, d.total}
		}
		s.mu.Unlock()
		out.Ocr = append(out.Ocr, o)
	}
	return out
}

type DocRow struct {
	ID        string `json:"id"`
	Path      string `json:"path"`
	Title     string `json:"title"`
	Ext       string `json:"ext"`
	Status    string `json:"status"`
	Error     string `json:"error,omitempty"`
	Chunks    int    `json:"chunks"`
	Ocr       bool   `json:"ocr"`
	Vectors   bool   `json:"vectors"`
	IndexedAt int64  `json:"indexedAt"`
	Size      int64  `json:"size"`
}

var localeCollator = collate.New(language.Und)

func (s *Service) Docs(sourceID, filter string) []DocRow {
	f := strings.ToLower(deps.Trim(filter))
	list := []*DocRec{}
	for _, d := range s.Index.BySource(sourceID) {
		if f == "" || strings.Contains(strings.ToLower(d.Path), f) {
			list = append(list, d)
		}
	}
	sort.SliceStable(list, func(i, j int) bool { return localeCollator.CompareString(list[i].Path, list[j].Path) < 0 })
	if len(list) > 500 {
		list = list[:500]
	}
	out := make([]DocRow, len(list))
	for i, d := range list {
		out[i] = DocRow{d.ID, d.Path, d.Title, d.Ext, d.Status, d.Error, len(d.Chunks), d.Ocr, d.EmbedModel != "", d.IndexedAt, d.Size}
	}
	return out
}

// Start：幂等；20 秒后首次增量索引，之后每 30 分钟
func (s *Service) Start() {
	s.mu.Lock()
	if s.started {
		s.mu.Unlock()
		return
	}
	s.started = true
	stop := make(chan struct{})
	s.stop = stop
	s.mu.Unlock()
	go func() {
		select {
		case <-stop:
			return
		case <-time.After(20 * time.Second):
			s.Reindex(context.Background(), nil, false)
		}
		t := time.NewTicker(30 * time.Minute)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				s.Reindex(context.Background(), nil, false)
			}
		}
	}()
	off := s.broker().OnChange(func() {
		s.pruneRevoked(context.Background())
		s.broadcast("kb.changed", nil)
	})
	s.mu.Lock()
	s.offBroker = off
	s.mu.Unlock()
}

func (s *Service) Dispose() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.started = false
	if s.stop != nil {
		close(s.stop)
		s.stop = nil
	}
	if s.offBroker != nil {
		s.offBroker()
		s.offBroker = nil
	}
	if s.job != nil {
		s.job.cancel()
	}
	for _, d := range s.downloads {
		d.cancel()
	}
}

// StartReindex：后台开始，立即返回当前进度
func (s *Service) StartReindex(force bool) KbProgress {
	ch := make(chan struct{})
	go s.reindex(context.Background(), nil, force, func() { close(ch) })
	<-ch // Node 在同一 tick 内同步进入 scan
	return s.Progress()
}

func (s *Service) Clear() bool {
	s.Index.Clear()
	_ = s.Index.Save()
	s.broadcast("kb.changed", nil)
	return true
}

func (s *Service) audit(tool string, args any, decision, result string, ms *int64, provider, source string) {
	if s.d.Desktop != nil {
		s.d.Desktop.Append(deps.AuditEntry{Tool: tool, Args: args, Decision: decision, Result: result, Ms: ms, Provider: provider, Source: source})
	}
}

func (s *Service) broadcast(ch string, payload any) {
	if s.d.Events != nil {
		s.d.Events.Publish(ch, payload)
	}
}

func itoa(i int) string { return strconvItoa(i) }

// parseFile = desktop/parse/runParse 的 parseFile（受限子进程里解析）
func parseFile(_ context.Context, path string) ParseResult {
	r := dparse.ParseFile(path, dparse.ParseOptions{})
	return ParseResult{OK: r.OK, Text: r.Text, PageTexts: r.PageTexts, Message: r.Message}
}
