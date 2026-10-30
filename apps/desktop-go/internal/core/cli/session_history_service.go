package cli

// SessionHistoryService = apps/desktop-electron/internal/core/src/cli/SessionHistoryService.ts（1:1 移植）。
// 编程助手历史会话（读本机磁盘）：Claude / Codex / dsh / Gemini / Grok 的会话文件扫描、
// 增量解析、分页、读转录、打开（交给标签层续接）、删除（移到废纸篓）。

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/klauspost/compress/zstd"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/claude"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/codex"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/dsh"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/gemini"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/grok"
	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/agents"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// historyScan = HISTORY_SCAN（各 CLI 的历史文件扫描，插件给出）。
var historyScan = map[string]*clisdk.HistoryCapability{
	"claude": claude.History,
	"codex":  codex.History,
	"dsh":    dsh.History,
	"gemini": gemini.History,
	"grok":   grok.History,
}

const (
	HistoryPageSize       = 20
	HistoryMaxItems       = 500
	historyListTTLMs      = 3000
	historyMaxParsedCache = 6000
	historyMaxTranscript  = 12 * 1024 * 1024
	DshMetaMaxZstdBytes   = 2 * 1024 * 1024
	CodexMetaMaxZstBytes  = 4 * 1024 * 1024
	ZstdMaxOutputBytes    = 256 * 1024 * 1024
)

var (
	codexIDRe      = regexp.MustCompile(`(?i)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$`)
	hasUserTypeRe  = regexp.MustCompile(`"type"` + util.JSWhitespace + `*:` + util.JSWhitespace + `*"user"`)
	leadingBraceRe = regexp.MustCompile(`^` + util.JSWhitespace + `*\{`)
	zstdExtRe      = regexp.MustCompile(`\.zstd?$`)
)

var historyBackends = []string{"claude", "codex", "dsh", "gemini", "grok"}

func isHistoryBackend(b string) bool {
	for _, x := range historyBackends {
		if x == b {
			return true
		}
	}
	return false
}

// HistoryAccount = sessionAccount 的返回值（Label "" = undefined）。
type HistoryAccount struct{ ID, Label string }

// HistoryOpenTabResult = openTab 的返回值。
type HistoryOpenTabResult struct {
	Tab    any
	Reused bool
}

// SessionHistoryDeps = SessionHistoryDeps（空串 / nil = undefined）。
type SessionHistoryDeps struct {
	Home, DshHome, GeminiHome string
	HasHome, HasDshHome       bool
	Env                       *util.Obj
	Logger                    interface{ Warn(m string, d ...any) }
	OpenKeys                  func() map[string]bool
	OpenTitle                 func(backend, sessionID, title string)
	// OpenTab 的参数按 Node 的键顺序组装成对象。
	OpenTab        func(o *util.Obj) HistoryOpenTabResult
	SessionModel   func(backend, sessionID string) string
	GatewaySession func(backend, sessionID string) bool
	AccountLabel   func(backend, accountID string) string
	SessionAccount func(backend, sessionID string) *HistoryAccount
	Trash          func(p string) *jsrt.Promise[struct{}]
	CodexThreads   func(file string) *jsrt.Promise[[]*util.Obj]
}

type historyFile struct {
	Path  string
	Mtime float64
	Size  float64
	DirID string
}

type historyParsed struct {
	mtime, size float64
	meta        *util.Obj // nil = null；含 accountId（不交给界面）
}

type historyKeyed struct {
	historyFile
	meta *util.Obj
}

type SessionHistoryService struct {
	d       SessionHistoryDeps
	home    string
	dshHome string
	listAt  map[string]float64
	listEnt map[string][]historyFile
	parsed  map[string]historyParsed
	byKey   map[string]historyKeyed
	idxSig  *string
	idxRows map[string]*util.Obj
	idxIDs  []string
	refresh *jsrt.Promise[struct{}]
}

func NewSessionHistoryService(d SessionHistoryDeps) *SessionHistoryService {
	s := &SessionHistoryService{d: d, listAt: map[string]float64{}, listEnt: map[string][]historyFile{},
		parsed: map[string]historyParsed{}, byKey: map[string]historyKeyed{}, idxRows: map[string]*util.Obj{}}
	if d.HasHome {
		s.home = d.Home
	} else {
		s.home = usage.Homedir()
	}
	if d.HasDshHome {
		s.dshHome = d.DshHome
	} else if v, ok := os.LookupEnv("DSH_HOME"); ok && util.JSTrim(v) != "" {
		s.dshHome, _ = filepath.Abs(v)
	} else {
		s.dshHome = filepath.Join(s.home, ".dsh")
	}
	return s
}

func (s *SessionHistoryService) env() *util.Obj {
	if s.d.Env != nil {
		return s.d.Env
	}
	return usage.ProcessEnv()
}

func (s *SessionHistoryService) geminiRoot() string {
	if s.d.GeminiHome != "" {
		return filepath.Join(s.d.GeminiHome, ".gemini")
	}
	return usage.GeminiDir(s.home, nil)
}

func (s *SessionHistoryService) historyRoot(backend string) string {
	env := s.env()
	switch backend {
	case "claude":
		return filepath.Join(usage.ClaudeConfigDir(s.home, env), "projects")
	case "codex":
		return filepath.Join(usage.CodexHomeDir(s.home, env), "sessions")
	case "gemini":
		return filepath.Join(s.geminiRoot(), "tmp")
	case "grok":
		return filepath.Join(usage.GrokHomeDir(s.home, env), "sessions")
	}
	return filepath.Join(s.dshHome, "sessions")
}

func shNowMs() float64 { return float64(time.Now().UnixNano()) / 1e6 }

func (s *SessionHistoryService) candidates(backend string, force bool) []historyFile {
	if at, ok := s.listAt[backend]; ok && !force && shNowMs()-at < historyListTTLMs {
		return s.listEnt[backend]
	}
	entries := []historyFile{}
	for _, f := range historyScan[backend].Scan(s.historyRoot(backend)) {
		entries = append(entries, historyFile{f.Path, f.Mtime, f.Size, f.DirID})
	}
	if backend == "codex" {
		s.refreshCodexIndex(filepath.Join(usage.CodexHomeDir(s.home, s.env()), "state_5.sqlite"))
		for k := range s.byKey {
			if strings.HasPrefix(k, "codex:") {
				delete(s.byKey, k)
			}
		}
	}
	sort.SliceStable(entries, func(i, j int) bool { return entries[j].Mtime-entries[i].Mtime < 0 })
	s.listAt[backend] = shNowMs()
	s.listEnt[backend] = entries
	return entries
}

// bufString = Buffer#toString('utf8')（WHATWG 替换，不吞 BOM）。
func shBufString(b []byte) string {
	pre := ""
	if bytes.HasPrefix(b, []byte{0xEF, 0xBB, 0xBF}) {
		pre, b = "\uFEFF", b[3:]
	}
	d := &util.TextDecoder{}
	return pre + d.Decode(b) + d.Flush()
}

func shReadHead(p string, n int64) string {
	fh, err := os.Open(p)
	if err != nil {
		return ""
	}
	defer fh.Close()
	st, err := fh.Stat()
	if err != nil {
		return ""
	}
	if st.IsDir() {
		return ""
	}
	l := n
	if st.Size() < l {
		l = st.Size()
	}
	buf := make([]byte, l)
	if _, err := io.ReadFull(fh, buf); err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return ""
	}
	return shBufString(buf)
}

func shReadTailText(p string, n int64) (string, bool, error) {
	fh, err := os.Open(p)
	if err != nil {
		return "", false, err
	}
	defer fh.Close()
	st, err := fh.Stat()
	if err != nil {
		return "", false, err
	}
	if st.IsDir() {
		return "", false, errors.New("EISDIR: illegal operation on a directory, read")
	}
	size := st.Size()
	l := n
	if size < l {
		l = size
	}
	buf := make([]byte, l)
	if _, err := fh.ReadAt(buf, size-l); err != nil && !errors.Is(err, io.EOF) {
		return "", false, err
	}
	text := shBufString(buf)
	truncated := size > l
	if truncated {
		text = text[strings.Index(text, "\n")+1:]
	}
	return text, truncated, nil
}

var errZstdTooLarge = errors.New("Cannot create a Buffer larger than the maximum size")

// ZstdDecode = zstdDecode：先用内置解码（klauspost/compress，对应 Node 自带 zlib.zstdDecompress），
// 失败时退回外部 `zstd -dc`；超过上限直接失败。
func ZstdDecode(buf []byte, maxBytes int) (string, error) {
	dec, err := zstd.NewReader(nil, zstd.WithDecoderMaxMemory(uint64(maxBytes)), zstd.WithDecoderConcurrency(1))
	if err == nil {
		out, derr := dec.DecodeAll(buf, nil)
		dec.Close()
		if derr == nil {
			if len(out) > maxBytes {
				return "", errZstdTooLarge
			}
			return shBufString(out), nil
		}
		if errors.Is(derr, zstd.ErrDecoderSizeExceeded) || errors.Is(derr, zstd.ErrWindowSizeExceeded) || errors.Is(derr, zstd.ErrFrameSizeExceeded) {
			return "", errZstdTooLarge
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "zstd", "-dc")
	cmd.Stdin = bytes.NewReader(buf)
	var stdout limitBuf
	stdout.max = maxBytes
	cmd.Stdout = &stdout
	if err := cmd.Run(); err != nil {
		return "", err
	}
	if stdout.over {
		return "", errors.New("stdout maxBuffer length exceeded")
	}
	return shBufString(stdout.b.Bytes()), nil
}

type limitBuf struct {
	b    bytes.Buffer
	max  int
	over bool
}

func (l *limitBuf) Write(p []byte) (int, error) {
	if l.b.Len()+len(p) > l.max {
		l.over = true
		return 0, errors.New("maxBuffer")
	}
	return l.b.Write(p)
}

// sameJS = a !== b 取反（sqlite 行的列值：字符串 / 数字 / null / undefined）。
func shSameJS(a, b *util.Obj, k string) bool {
	if a.Has(k) != b.Has(k) {
		return false
	}
	x, y := a.Get(k), b.Get(k)
	if xf, ok := x.(float64); ok {
		yf, ok2 := y.(float64)
		return ok2 && xf == yf
	}
	return util.Stringify(x) == util.Stringify(y) && fmt.Sprintf("%T", x) == fmt.Sprintf("%T", y)
}

// CodexRowsChanged = codexRowsChanged（Map 以插入顺序的 id 列表 + 行表示）。
func CodexRowsChanged(prevIDs []string, prev map[string]*util.Obj, nextIDs []string, next map[string]*util.Obj) []string {
	out := []string{}
	seen := map[string]bool{}
	add := func(id string) {
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	same := func(a, b *util.Obj) bool {
		for _, k := range append(append([]string{}, a.Keys()...), b.Keys()...) {
			if !shSameJS(a, b, k) {
				return false
			}
		}
		return true
	}
	for _, id := range nextIDs {
		old, ok := prev[id]
		if !ok || old == nil || !same(old, next[id]) {
			add(id)
		}
	}
	for _, id := range prevIDs {
		if _, ok := next[id]; !ok {
			add(id)
		}
	}
	return out
}

func shBaseExt(p, ext string) string {
	b := filepath.Base(p)
	if strings.HasSuffix(b, ext) && b != ext {
		return b[:len(b)-len(ext)]
	}
	return b
}

func shRowStr(row *util.Obj, k string) string {
	if row == nil {
		return ""
	}
	v, _ := row.Get(k).(string)
	return v
}

func cleanTitle80(raw string) *string { return sh.CleanTitle(raw, 80) }

func shSetIf(o *util.Obj, k, v string) {
	if v != "" {
		o.Set(k, v)
	}
}

func shSetPerm(o *util.Obj, backend string, raw *string) {
	if raw != nil && *raw != "" {
		if m := FromCliPermissionMode(backend, *raw); m != "" {
			o.Set("permissionMode", m)
		}
	}
}

func (s *SessionHistoryService) inspect(backend string, f historyFile) *util.Obj {
	switch backend {
	case "claude":
		head := shReadHead(f.Path, 128*1024)
		info := agents.ParseClaudeSession(head, "")
		for _, e := range agents.JsonlEvents(head, 200) {
			if t := e.Get("type"); t == "user" || t == "assistant" {
				if e.Get("isSidechain") == true {
					return nil
				}
				break
			}
		}
		sid := info.SessionID
		if sid == "" {
			sid = shBaseExt(f.Path, ".jsonl")
		}
		title := info.Title
		if title == "" && hasUserTypeRe.MatchString(head) {
			title = i18n.T("electron.common.untitled-session")
		}
		if title == "" {
			return nil
		}
		o := util.NewObj("key", "claude:"+sid, "backend", backend, "sessionId", sid, "title", title)
		shSetIf(o, "cwd", info.Cwd)
		shSetIf(o, "model", info.Model)
		shSetIf(o, "reasoningEffort", info.ReasoningEffort)
		shSetPerm(o, "claude", info.PermissionMode)
		return o
	case "codex":
		idFromName := ""
		if m := codexIDRe.FindStringSubmatch(filepath.Base(f.Path)); m != nil {
			idFromName = m[1]
		}
		var row *util.Obj
		if idFromName != "" {
			row = s.idxRows[idFromName]
		}
		if row != nil && util.Truthy(row.Get("archived")) {
			return nil
		}
		head := ""
		if !strings.HasSuffix(f.Path, ".zst") {
			head = shReadHead(f.Path, 512*1024)
		} else if row == nil && f.Size <= CodexMetaMaxZstBytes {
			if b, err := os.ReadFile(f.Path); err == nil {
				if x, err := ZstdDecode(b, ZstdMaxOutputBytes); err == nil {
					head = util.UTF16Slice0(x, 512*1024)
				}
			}
		}
		info := agents.ParseCodexSession(head, "")
		sm := CodexSessionMeta(head)
		sid := info.SessionID
		if sid == "" {
			sid = shRowStr(row, "id")
		}
		if sid == "" {
			sid = idFromName
		}
		var src any
		if row != nil && row.Get("source") != nil {
			src = row.Get("source")
		} else if sm.Has("source") {
			src = sm.Get("source")
		}
		if IsCodexSubagentSource(src) {
			return nil
		}
		orig, _ := sm.Get("originator").(string)
		if orig == "" {
			orig = shRowStr(row, "originator")
		}
		var src2 any
		if sm.Has("source") {
			src2 = sm.Get("source")
		} else if row != nil {
			src2 = row.Get("source")
		}
		client := CodexClient(orig, src2)
		var title *string
		for _, c := range []func() *string{
			func() *string { return cleanTitle80(shRowStr(row, "name")) },
			func() *string { return cleanTitle80(shRowStr(row, "title")) },
			func() *string { return shSp(info.Title) },
			func() *string { return cleanTitle80(shRowStr(row, "first_user_message")) },
		} {
			if title = c(); title != nil {
				break
			}
		}
		if title == nil && client == "desktop" {
			t := i18n.T("electron.common.untitled-session")
			title = &t
		}
		if sid == "" || title == nil || *title == "" {
			return nil
		}
		model := info.Model
		if model == "" {
			model = shRowStr(row, "model")
		}
		effort := info.ReasoningEffort
		if effort == "" {
			effort = shRowStr(row, "reasoning_effort")
		}
		provider := ""
		if row != nil && row.Get("model_provider") != nil {
			provider = shRowStr(row, "model_provider")
		} else {
			provider, _ = sm.Get("modelProvider").(string)
		}
		route := CodexRoute(provider)
		o := util.NewObj("key", "codex:"+sid, "backend", backend, "sessionId", sid, "title", *title)
		if info.Cwd != "" {
			o.Set("cwd", info.Cwd)
		} else if row != nil {
			if c, ok := row.Get("cwd").(string); ok {
				o.Set("cwd", c)
			}
		}
		shSetIf(o, "model", model)
		shSetIf(o, "reasoningEffort", effort)
		shSetPerm(o, "codex", info.PermissionMode)
		shSetIf(o, "client", client)
		o.Set("route", route)
		if route == "custom" {
			shSetIf(o, "provider", provider)
		}
		shSetIf(o, "accountId", shRowStr(row, "creator_account_id"))
		return o
	case "gemini":
		head := shReadHead(f.Path, 256*1024)
		chat := gemini.FoldChat(head)
		if chat.SessionID == "" || chat.Kind == "subagent" {
			return nil
		}
		info := agents.ParseGeminiSession(head)
		var first any
		for _, m := range chat.Messages {
			if m.Get("type") == "user" {
				first = m.Get("content")
				break
			}
		}
		title := cleanTitle80(chat.Summary)
		if title == nil {
			title = cleanTitle80(gemini.Text(first))
		}
		if title == nil {
			return nil
		}
		marker := shReadHead(filepath.Join(filepath.Dir(filepath.Dir(f.Path)), ".project_root"), 4096)
		o := util.NewObj("key", "gemini:"+chat.SessionID, "backend", backend, "sessionId", chat.SessionID, "title", *title)
		shSetIf(o, "cwd", util.JSTrim(marker))
		shSetIf(o, "model", info.Model)
		shSetIf(o, "reasoningEffort", info.ReasoningEffort)
		shSetPerm(o, "gemini", info.PermissionMode)
		return o
	case "grok":
		text := shReadHead(f.Path, 512*1024)
		sid := f.DirID
		if sid == "" {
			sid = filepath.Base(filepath.Dir(f.Path))
		}
		info := agents.ParseGrokSession(text, sid)
		enc := filepath.Base(filepath.Dir(filepath.Dir(f.Path)))
		if d, err := util.DecodeURIComponent(enc); err == nil {
			enc = d
		}
		cwd := info.Cwd
		if cwd == "" {
			cwd = enc
		}
		title := shSp(info.Title)
		if title == nil {
			title = TitleFromMessages(ParseTranscript("grok", text, shNowMs()))
		}
		if title == nil || *title == "" {
			return nil
		}
		o := util.NewObj("key", "grok:"+sid, "backend", backend, "sessionId", sid, "title", *title)
		shSetIf(o, "cwd", cwd)
		shSetIf(o, "model", info.Model)
		shSetIf(o, "reasoningEffort", info.ReasoningEffort)
		shSetPerm(o, "grok", info.PermissionMode)
		return o
	}
	id := f.DirID
	if id == "" {
		id = filepath.Base(filepath.Dir(f.Path))
	}
	meta := agents.ParseDshProjcache(shReadHead(filepath.Join(s.dshHome, "storages", "session_projcache", "sessions", id+".json"), 256*1024))
	if meta.Title == "" {
		return nil
	}
	si := agents.ParseDshSession("", id)
	func() {
		raw := ""
		if strings.HasSuffix(f.Path, ".zstd") {
			if f.Size > DshMetaMaxZstdBytes {
				return
			}
			b, err := os.ReadFile(f.Path)
			if err != nil {
				return
			}
			x, err := ZstdDecode(b, ZstdMaxOutputBytes)
			if err != nil {
				return
			}
			raw = util.UTF16Slice0(x, 512*1024)
		} else {
			raw = shReadHead(f.Path, 512*1024)
		}
		si = agents.ParseDshSession(raw, id)
	}()
	o := util.NewObj("key", "dsh:"+id, "backend", backend, "sessionId", id, "title", meta.Title)
	if meta.Cwd != nil {
		o.Set("cwd", *meta.Cwd)
	} else {
		shSetIf(o, "cwd", si.Cwd)
	}
	shSetIf(o, "model", si.Model)
	shSetIf(o, "reasoningEffort", si.ReasoningEffort)
	pm := si.PermissionMode
	if pm == nil && meta.PermissionMode != "" {
		v := meta.PermissionMode
		pm = &v
	}
	shSetPerm(o, "dsh", pm)
	return o
}

func shSp(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func (s *SessionHistoryService) parsedOf(backend string, f historyFile) *util.Obj {
	var meta *util.Obj
	if hit, ok := s.parsed[f.Path]; ok && hit.mtime == f.Mtime && hit.size == f.Size {
		meta = hit.meta
	} else {
		meta = s.inspect(backend, f)
		if len(s.parsed) > historyMaxParsedCache {
			s.parsed = map[string]historyParsed{}
		}
		s.parsed[f.Path] = historyParsed{f.Mtime, f.Size, meta}
	}
	if meta != nil {
		k, _ := meta.Get("key").(string)
		cur, ok := s.byKey[k]
		if !ok || cur.Path == f.Path || f.Mtime > cur.Mtime || (f.Mtime == cur.Mtime && f.Path < cur.Path) {
			s.byKey[k] = historyKeyed{f, meta}
		}
	}
	return meta
}

// HistoryPageOpts = list / index 的参数（nil = undefined）。
type HistoryPageOpts struct {
	Offset, Limit *float64
	Force         bool
}

func (s *SessionHistoryService) List(backend string, o HistoryPageOpts) *jsrt.Promise[*util.Obj] {
	return jsrt.Async(func() (*util.Obj, error) { return s.page(backend, o, false) })
}

func (s *SessionHistoryService) Index(backend string, o HistoryPageOpts) *jsrt.Promise[*util.Obj] {
	return jsrt.Async(func() (*util.Obj, error) { return s.page(backend, o, true) })
}

func shRound(x float64) float64 { return math.Floor(x + 0.5) }

func (s *SessionHistoryService) page(backend string, o HistoryPageOpts, cheap bool) (*util.Obj, error) {
	if !isHistoryBackend(backend) {
		return nil, errors.New(i18n.T("electron.common.unknown-backend"))
	}
	lim := float64(HistoryPageSize)
	if o.Limit != nil {
		lim = *o.Limit
	}
	limit := math.Min(HistoryPageSize, math.Max(1, shRound(lim)))
	off := 0.0
	if o.Offset != nil {
		off = *o.Offset
	}
	offset := math.Max(0, shRound(off))
	entries := s.candidates(backend, o.Force)
	if offset >= HistoryMaxItems {
		return util.NewObj("items", []any{}, "nextOffset", nil, "hasMore", false), nil
	}
	open := map[string]bool{}
	if s.d.OpenKeys != nil {
		if m := s.d.OpenKeys(); m != nil {
			open = m
		}
	}
	target := math.Min(HistoryMaxItems, offset+limit+1)
	visible := []*util.Obj{}
	scan := 0
	for scan < len(entries) && float64(len(visible)) < target {
		n := int(math.Max(8, target-float64(len(visible))))
		end := scan + n
		if end > len(entries) {
			end = len(entries)
		}
		batch := entries[scan:end]
		metas := make([]*util.Obj, len(batch))
		for i, f := range batch {
			metas[i] = s.parsedOf(backend, f)
		}
		for k := range batch {
			m, f := metas[k], batch[k]
			scan++
			if m == nil {
				continue
			}
			key, _ := m.Get("key").(string)
			sid, _ := m.Get("sessionId").(string)
			if open[key] {
				if s.d.OpenTitle != nil {
					t, _ := m.Get("title").(string)
					s.d.OpenTitle(backend, sid, t)
				}
				continue
			}
			if c, ok := s.byKey[key]; !ok || c.Path != f.Path {
				continue
			}
			accountID, _ := m.Get("accountId").(string)
			account := ""
			if accountID != "" && s.d.AccountLabel != nil {
				account = s.d.AccountLabel(backend, accountID)
			}
			if account == "" && s.d.SessionAccount != nil {
				if a := s.d.SessionAccount(backend, sid); a != nil {
					account = a.Label
				}
			}
			item := util.NewObj()
			for _, k := range m.Keys() {
				if k != "accountId" {
					item.Set(k, m.Get(k))
				}
			}
			shSetIf(item, "account", account)
			cwd, _ := m.Get("cwd").(string)
			item.Set("cwdMissing", !cheap && cwd != "" && !shIsDir(cwd))
			item.Set("updatedAt", f.Mtime)
			visible = append(visible, item)
			if float64(len(visible)) >= target {
				break
			}
		}
	}
	lo := int(math.Min(offset, float64(len(visible))))
	hi := int(math.Min(offset+limit, float64(len(visible))))
	if hi < lo {
		hi = lo
	}
	items := make([]any, 0, hi-lo)
	for _, v := range visible[lo:hi] {
		items = append(items, v)
	}
	pageEnd := offset + float64(len(items))
	hasMore := float64(len(visible)) > pageEnd && pageEnd < HistoryMaxItems
	var next any
	if hasMore {
		next = pageEnd
	}
	return util.NewObj("items", items, "nextOffset", next, "hasMore", hasMore), nil
}

func (s *SessionHistoryService) Transcript(backend, sessionID string) *jsrt.Promise[*util.Obj] {
	return jsrt.Async(func() (*util.Obj, error) { return s.transcript(backend, sessionID), nil })
}

func shMsgsAny(ms []*util.Obj) []any {
	out := make([]any, len(ms))
	for i, m := range ms {
		out[i] = m
	}
	return out
}

func (s *SessionHistoryService) transcript(backend, sessionID string) *util.Obj {
	f := s.locate(backend, sessionID)
	if f == nil {
		return util.NewObj("messages", []any{}, "truncated", false, "note", i18n.T("electron.common.could-not-find-the-record-file-for-this"))
	}
	var text string
	truncated := false
	var err error
	if zstdExtRe.MatchString(f.Path) {
		var b []byte
		if b, err = os.ReadFile(f.Path); err == nil {
			text, err = ZstdDecode(b, ZstdMaxOutputBytes)
		}
	} else {
		text, truncated, err = shReadTailText(f.Path, historyMaxTranscript)
	}
	if err == nil {
		var msgs []*util.Obj
		func() {
			defer func() {
				if r := recover(); r != nil {
					err = fmt.Errorf("%v", r)
				}
			}()
			msgs = ParseTranscript(backend, text, f.Mtime)
		}()
		if err == nil {
			if len(msgs) == 0 {
				return util.NewObj("messages", []any{}, "truncated", truncated, "note", i18n.T("electron.common.no-displayable-history-messages-were-found"))
			}
			return util.NewObj("messages", shMsgsAny(msgs), "truncated", truncated)
		}
	}
	if s.d.Logger != nil {
		s.d.Logger.Warn("history transcript failed", err)
	}
	return util.NewObj("messages", []any{}, "truncated", false, "note", i18n.T("electron.common.could-not-read-the-history-messages-you-can"))
}

func shExists(p string) bool { _, err := os.Stat(p); return err == nil }

func (s *SessionHistoryService) locate(backend, sessionID string) *historyKeyed {
	key := backend + ":" + sessionID
	if c, ok := s.byKey[key]; ok && shExists(c.Path) {
		return &c
	}
	entries := s.candidates(backend, true)
	for i := 0; i < len(entries); i += 16 {
		end := i + 16
		if end > len(entries) {
			end = len(entries)
		}
		for _, f := range entries[i:end] {
			s.parsedOf(backend, f)
		}
		if h, ok := s.byKey[key]; ok {
			return &h
		}
	}
	return nil
}

func (s *SessionHistoryService) Open(backend, sessionID string) *jsrt.Promise[*util.Obj] {
	return jsrt.Async(func() (*util.Obj, error) {
		r, err := s.open(backend, sessionID)
		if err != nil {
			return util.NewObj("ok", false, "error", err.Error()), nil
		}
		return r, nil
	})
}

func (s *SessionHistoryService) open(backend, sessionID string) (*util.Obj, error) {
	if s.d.OpenTab == nil {
		return nil, errors.New(i18n.T("electron.common.opening-history-sessions-is-not-supported-here"))
	}
	f := s.locate(backend, sessionID)
	if f == nil || f.meta == nil {
		return util.NewObj("ok", false, "error", i18n.T("electron.common.session-not-found-it-may-have-been-deleted")), nil
	}
	cwd, _ := f.meta.Get("cwd").(string)
	if cwd == "" || !shIsDir(cwd) {
		c := cwd
		if !f.meta.Has("cwd") {
			c = "?"
		}
		return util.NewObj("ok", false, "error", i18n.T("electron.common.the-original-working-directory-no-longer-exists-resuming", c)), nil
	}
	tr := s.transcript(backend, sessionID)
	title, _ := f.meta.Get("title").(string)
	if title == "" {
		var ms []*util.Obj
		for _, m := range tr.Get("messages").([]any) {
			ms = append(ms, m.(*util.Obj))
		}
		if t := TitleFromMessages(ms); t != nil && *t != "" {
			title = *t
		} else {
			title = sessionID
		}
	}
	route, _ := f.meta.Get("route").(string)
	if route == "" && s.d.GatewaySession != nil && s.d.GatewaySession(backend, sessionID) {
		route = "gateway"
	}
	arg := util.NewObj("backend", backend, "sessionId", sessionID, "cwd", cwd, "title", title, "messages", tr.Get("messages"))
	str := func(k string) string { v, _ := f.meta.Get(k).(string); return v }
	if v := str("model"); v != "" {
		arg.Set("modelOverride", v)
	}
	shSetIf(arg, "reasoningEffort", str("reasoningEffort"))
	if v := str("permissionMode"); v != "" {
		arg.Set("permissionMode", v)
	} else {
		arg.Set("permissionModeSource", "history-cli")
	}
	if s.d.SessionAccount != nil {
		if a := s.d.SessionAccount(backend, sessionID); a != nil {
			arg.Set("accountId", a.ID)
		}
	}
	if route != "" {
		if route == "gateway" {
			arg.Set("source", "thirdParty")
		} else {
			arg.Set("source", "official")
		}
	}
	if route == "gateway" && s.d.SessionModel != nil {
		shSetIf(arg, "lastServedRef", s.d.SessionModel(backend, sessionID))
	}
	r := s.d.OpenTab(arg)
	out := util.NewObj("ok", true, "tab", r.Tab, "reused", r.Reused)
	if !r.Reused {
		if n, ok := tr.Get("note").(string); ok {
			out.Set("notice", n)
		} else if tr.Get("truncated") == true {
			out.Set("notice", i18n.T("electron.common.long-history-only-the-most-recent-messages-are"))
		}
	}
	return out, nil
}

func (s *SessionHistoryService) Remove(backend, sessionID string) *jsrt.Promise[*util.Obj] {
	return jsrt.Async(func() (*util.Obj, error) {
		r, err := s.remove(backend, sessionID)
		if err != nil {
			return util.NewObj("ok", false, "error", err.Error()), nil
		}
		return r, nil
	})
}

func (s *SessionHistoryService) remove(backend, sessionID string) (*util.Obj, error) {
	if !isHistoryBackend(backend) {
		return nil, errors.New(i18n.T("electron.common.unknown-backend"))
	}
	if s.d.Trash == nil {
		return nil, errors.New(i18n.T("electron.common.deleting-history-sessions-is-not-supported-here"))
	}
	key := backend + ":" + sessionID
	if s.d.OpenKeys != nil && s.d.OpenKeys()[key] {
		return util.NewObj("ok", false, "error", i18n.T("electron.common.this-session-is-open-in-a-tab-close")), nil
	}
	files := s.sessionFiles(backend, key)
	if len(files) == 0 {
		return util.NewObj("ok", false, "error", i18n.T("electron.common.session-not-found-it-may-have-been-deleted")), nil
	}
	targets := []string{}
	seen := map[string]bool{}
	for _, f := range files {
		for _, p := range s.deletionTargets(backend, f, sessionID) {
			if !seen[p] {
				seen[p] = true
				targets = append(targets, p)
			}
		}
	}
	roots := s.deletionRoots(backend)
	removed := 0
	for _, p := range targets {
		if !shExists(p) {
			continue
		}
		if !shInsideRoots(p, roots) {
			if s.d.Logger != nil {
				s.d.Logger.Warn("history delete: target outside session roots, skipped", p)
			}
			continue
		}
		if _, err := jsrt.Await(s.d.Trash(p)); err != nil {
			return nil, err
		}
		removed++
	}
	delete(s.listAt, backend)
	delete(s.listEnt, backend)
	for _, f := range files {
		delete(s.parsed, f.Path)
	}
	delete(s.byKey, key)
	return util.NewObj("ok", true, "removed", removed), nil
}

func (s *SessionHistoryService) sessionFiles(backend, key string) []historyFile {
	entries := s.candidates(backend, true)
	out := []historyFile{}
	for i := 0; i < len(entries); i += 16 {
		end := i + 16
		if end > len(entries) {
			end = len(entries)
		}
		batch := entries[i:end]
		metas := make([]*util.Obj, len(batch))
		for k, f := range batch {
			metas[k] = s.parsedOf(backend, f)
		}
		for k, m := range metas {
			if m != nil && m.Get("key") == key {
				out = append(out, batch[k])
			}
		}
	}
	return out
}

func (s *SessionHistoryService) deletionTargets(backend string, f historyFile, sessionID string) []string {
	dir := filepath.Dir(f.Path)
	switch backend {
	case "claude":
		return []string{f.Path, filepath.Join(dir, shBaseExt(f.Path, ".jsonl"))}
	case "gemini":
		return []string{f.Path, filepath.Join(dir, sessionID)}
	case "grok":
		return []string{dir}
	case "dsh":
		id := f.DirID
		if id == "" {
			id = sessionID
		}
		return []string{dir, filepath.Join(s.dshHome, "storages", "session_projcache", "sessions", id+".json")}
	}
	return []string{f.Path}
}

func (s *SessionHistoryService) deletionRoots(backend string) []string {
	roots := []string{s.historyRoot(backend)}
	if backend == "dsh" {
		roots = append(roots, filepath.Join(s.dshHome, "storages", "session_projcache"))
	}
	return roots
}

func (s *SessionHistoryService) refreshCodexIndex(file string) {
	if s.refresh == nil {
		p := jsrt.Async(func() (struct{}, error) { s.doRefreshCodexIndex(file); return struct{}{}, nil })
		s.refresh = p
		jsrt.Await(p)
		if s.refresh == p {
			s.refresh = nil
		}
		return
	}
	jsrt.Await(s.refresh)
}

func (s *SessionHistoryService) doRefreshCodexIndex(file string) {
	sigV, ok := usage.DBSignature(file)
	var sig *string
	if ok {
		sig = &sigV
	}
	if (sig == nil && s.idxSig == nil) || (sig != nil && s.idxSig != nil && *sig == *s.idxSig) {
		return
	}
	rows := map[string]*util.Obj{}
	ids := []string{}
	if sig != nil {
		var list []*util.Obj
		var err error
		if s.d.CodexThreads != nil {
			list, err = jsrt.Await(s.d.CodexThreads(file))
		} else {
			list, err = jsrt.Await(ReadCodexThreadsAsync(file))
		}
		if err != nil {
			if s.d.Logger != nil {
				s.d.Logger.Warn("codex index refresh failed", err)
			}
			return
		}
		for _, r := range list {
			if id, _ := r.Get("id").(string); id != "" {
				if _, ok := rows[id]; !ok {
					ids = append(ids, id)
				}
				rows[id] = r
			}
		}
	}
	changed := CodexRowsChanged(s.idxIDs, s.idxRows, ids, rows)
	if len(changed) > 0 {
		ch := map[string]bool{}
		for _, c := range changed {
			ch[c] = true
		}
		for p := range s.parsed {
			if m := codexIDRe.FindStringSubmatch(filepath.Base(p)); m != nil && ch[m[1]] {
				delete(s.parsed, p)
			}
		}
	}
	s.idxSig, s.idxRows, s.idxIDs = sig, rows, ids
}

func shInsideRoots(p string, roots []string) bool {
	abs, err := filepath.Abs(p)
	if err != nil {
		return false
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(abs))
	if err != nil {
		return false
	}
	name := filepath.Base(p)
	if name == "" || name == "." || name == ".." || name == string(filepath.Separator) {
		return false
	}
	for _, r := range roots {
		root, err := filepath.EvalSymlinks(r)
		if err != nil {
			continue
		}
		if root, err = filepath.Abs(root); err != nil {
			continue
		}
		if parent == root || strings.HasPrefix(parent, root+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

func shIsDir(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

// CodexSessionMeta = codexSessionMeta（返回 {source?, originator?, modelProvider?}）。
func CodexSessionMeta(head string) *util.Obj {
	var e *util.Obj
	for _, x := range agents.JsonlEvents(head, 20) {
		if x.Get("type") == "session_meta" {
			e = x
			break
		}
	}
	p, _ := func() (*util.Obj, bool) {
		if e == nil {
			return nil, false
		}
		v, ok := e.Get("payload").(*util.Obj)
		return v, ok
	}()
	out := util.NewObj()
	if p == nil {
		return out
	}
	str := func(k string) string {
		v, ok := p.Get(k).(string)
		if ok && util.JSTrim(v) != "" {
			return v
		}
		return ""
	}
	if p.Has("source") && p.Get("source") != nil {
		out.Set("source", p.Get("source"))
	}
	shSetIf(out, "originator", str("originator"))
	shSetIf(out, "modelProvider", str("model_provider"))
	return out
}

// IsCodexSubagentSource = isCodexSubagentSource。
func IsCodexSubagentSource(source any) bool {
	v := source
	if str, ok := v.(string); ok {
		if !leadingBraceRe.MatchString(str) {
			return false
		}
		x, err := util.ParseString(str)
		if err != nil {
			return false
		}
		v = x
	}
	o, ok := v.(*util.Obj)
	return ok && o.Has("subagent")
}

// CodexRoute = codexRoute。
func CodexRoute(provider string) string {
	if provider == "" || provider == "openai" {
		return "official"
	}
	if provider == "nomi_gateway" {
		return "gateway"
	}
	return "custom"
}

// CodexClient = codexClient（"" = undefined）。
func CodexClient(originator string, source any) string {
	o := util.JSLower(util.JSTrim(originator))
	switch {
	case o == "nomi" || strings.HasPrefix(o, "nomi-"):
		return "nomi"
	case o == "codex desktop" || o == "codex_work_desktop":
		return "desktop"
	case o == "codex_vscode":
		return "ide"
	case o == "codex_exec" || source == "exec":
		return "exec"
	case o == "codex_cli_rs" || source == "cli":
		return "cli"
	case source == "vscode":
		return "ide"
	}
	return ""
}

var _ = json.Marshal
