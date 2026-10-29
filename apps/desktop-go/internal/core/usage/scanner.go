package usage

// UsageLogScanner.ts 的 1:1 移植：读取本机编程工具自己的会话日志，补齐不经过 Nomi 的用量。

import (
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/charcontract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const (
	grokLogRev      = 2
	readChunk       = 256 * 1024
	maxReadPerPass  = 8 * 1024 * 1024
	maxWholeFile    = 64 * 1024 * 1024
	maxFilesPerKind = 5000
	maxLookbackMs   = 400 * 86_400_000
	maxWalkEntries  = 50_000
	dirCacheRacyMs  = 2000
	fpBytes         = 256
)

// ScannerDeps = ScannerDeps。ZstdDecode 由装配处注入 cli.ZstdDecode（Go 包 core/cli 依赖本包，不能反向 import）。
type ScannerDeps struct {
	Ledger     *UsageLedger
	Home       *string
	DshHome    *string
	GrokHome   *string
	Env        *util.Obj
	Now        func() float64
	Logger     Logger
	Retention  func() Retention
	ClearedAt  func() float64
	RouteBusy  func(source UsageSource) bool
	OnNew      func(r *UsageRecord)
	OnQuota    func(q *CodexRateLimits)
	ZstdDecode func(b []byte) (string, error)
}

type found struct {
	source UsageSource
	path   string
	mtime  float64
	mode   string
}

type walkFile struct {
	Path  string  `json:"path"`
	Mtime float64 `json:"mtime"`
}

type dirEnt struct {
	name      string
	dir, file bool
}

type dirListing struct {
	mtimeMs, ino float64
	ents         []dirEnt
}

func statOf(p string) os.FileInfo {
	fi, err := os.Stat(p)
	if err != nil {
		return nil
	}
	return fi
}

func nowMs() float64 { return float64(time.Now().UnixMilli()) }

// walkAsync：深度优先（Node 版的并发预取不改变结果顺序）。
func walkAsync(dir string, pred func(name, full string) bool, depth int, since float64,
	cache map[string]*dirListing, seen map[string]bool) []walkFile {
	var files []string
	visited := 0
	var goDir func(d string, dep int)
	goDir = func(d string, dep int) {
		if dep < 0 || visited > maxWalkEntries {
			return
		}
		ents := listDir(d, cache, seen)
		if ents == nil {
			return
		}
		for _, e := range ents {
			visited++
			full := filepath.Join(d, e.name)
			if e.dir {
				goDir(full, dep-1)
			} else if e.file && pred(e.name, full) {
				files = append(files, full)
			}
		}
	}
	goDir(dir, depth)
	out := []walkFile{}
	for _, f := range files {
		if st := statOf(f); st != nil && mtimeMs(st) >= since {
			out = append(out, walkFile{f, mtimeMs(st)})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Mtime > out[j].Mtime })
	if len(out) > maxFilesPerKind {
		out = out[:maxFilesPerKind]
	}
	return out
}

func listDir(d string, cache map[string]*dirListing, seen map[string]bool) []dirEnt {
	if cache == nil {
		return readDirEnts(d)
	}
	st := statOf(d)
	if st == nil || !st.IsDir() {
		delete(cache, d)
		return nil
	}
	if seen != nil {
		seen[d] = true
	}
	_, ino := fileID(d, st)
	mt := mtimeMs(st)
	if hit := cache[d]; hit != nil && hit.mtimeMs == mt && hit.ino == ino {
		return hit.ents
	}
	listedAt := nowMs()
	ents := readDirEnts(d)
	if ents != nil && mt < listedAt-dirCacheRacyMs {
		cache[d] = &dirListing{mt, ino, ents}
	} else {
		delete(cache, d)
	}
	return ents
}

func readDirEnts(d string) []dirEnt {
	es, err := os.ReadDir(d)
	if err != nil {
		return nil
	}
	out := make([]dirEnt, 0, len(es))
	for _, e := range es {
		out = append(out, dirEnt{e.Name(), e.IsDir(), e.Type().IsRegular()})
	}
	return out
}

var jsonlExt = regexp.MustCompile(`\.jsonl?$`)

func splitSep(p string) []string { return strings.Split(p, string(filepath.Separator)) }

func lastIndex(a []string, s string) int {
	for i := len(a) - 1; i >= 0; i-- {
		if a[i] == s {
			return i
		}
	}
	return -1
}

func IsGeminiChatFile(name, full string) bool {
	if !jsonlExt.MatchString(name) {
		return false
	}
	parts := splitSep(full)
	i := lastIndex(parts, "chats")
	if i < 0 || i >= len(parts)-1 {
		return false
	}
	if len(parts)-1 == i+1 {
		return strings.HasPrefix(name, "session-")
	}
	return true
}

var hexHash = regexp.MustCompile(`(?i)^[0-9a-f]{32,}$`)

func geminiProject(file string) *string {
	parts := splitSep(file)
	i := lastIndex(parts, "chats")
	if i > 0 && parts[i-1] != "" && !hexHash.MatchString(parts[i-1]) {
		return strp(parts[i-1])
	}
	return nil
}

var uuidish = regexp.MustCompile(`^[0-9a-f-]{36}$`)

func KimiSessionId(file string) *string {
	parts := splitSep(file)
	a := lastIndex(parts, "agents")
	var id string
	if a > 0 && len(parts)-a == 3 {
		id = parts[a-1]
	} else if len(parts) >= 2 {
		id = parts[len(parts)-2]
	}
	if id == "" {
		return nil
	}
	low := strings.ToLower(id)
	for _, p := range []string{"ses_", "session_"} {
		if strings.HasPrefix(low, p) && uuidish.MatchString(strings.ToLower(id[len(p):])) {
			id = id[len(p):]
			break
		}
	}
	return strp(id)
}

type fpID struct {
	fp    string
	fpLen float64
}

func fingerprintAt(fh *os.File, offset float64) *fpID {
	l := math.Min(fpBytes, offset)
	if l <= 0 {
		return nil
	}
	buf := make([]byte, int(l))
	n, _ := fh.ReadAt(buf, int64(offset-l))
	if n != len(buf) {
		return nil
	}
	h := sha1.Sum(buf)
	return &fpID{hex.EncodeToString(h[:]), l}
}

func applyIdentity(c *FileCursor, p string, st os.FileInfo) {
	dev, ino := fileID(p, st)
	if ino != 0 {
		c.Dev, c.Ino = f64p(dev), f64p(ino)
	}
}

func applyFp(c *FileCursor, id *fpID) {
	if id != nil {
		c.Fp, c.FpLen = strp(id.fp), f64p(id.fpLen)
	}
}

func identityChanged(cur *FileCursor, p string, st os.FileInfo) bool {
	dev, ino := fileID(p, st)
	return cur.Ino != nil && ino != 0 && (*cur.Ino != ino || cur.Dev == nil || *cur.Dev != dev)
}

func tick() { runtime.Gosched() }

type UsageLogScanner struct {
	d        ScannerDeps
	home     string
	dshHome  string
	grokHome string
	env      *util.Obj
	mu       sync.Mutex
	running  bool
	dirCache map[string]*dirListing
}

func NewUsageLogScanner(d ScannerDeps) *UsageLogScanner {
	s := &UsageLogScanner{d: d, dirCache: map[string]*dirListing{}}
	if d.Home != nil {
		s.home = *d.Home
	} else {
		s.home = Homedir()
	}
	if d.Env != nil {
		s.env = d.Env
	} else {
		s.env = ProcessEnv()
	}
	if d.DshHome != nil {
		s.dshHome = *d.DshHome
	} else if raw, _ := Str(s.env, "DSH_HOME"); util.JSTrim(raw) != "" {
		s.dshHome, _ = filepath.Abs(raw)
	} else {
		s.dshHome = filepath.Join(s.home, ".dsh")
	}
	if d.GrokHome != nil {
		s.grokHome = *d.GrokHome
	} else {
		s.grokHome = GrokHomeDir(s.home, s.env)
	}
	return s
}

func (s *UsageLogScanner) now() float64 {
	if s.d.Now != nil {
		return s.d.Now()
	}
	return nowMs()
}

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

func (s *UsageLogScanner) Detected() []UsageSource {
	h := s.home
	out := []UsageSource{}
	if exists(s.claudeDir()) {
		out = append(out, "claude")
	}
	if exists(s.codexDir()) {
		out = append(out, "codex")
	}
	if exists(filepath.Join(s.dshHome, "sessions")) {
		out = append(out, "dsh")
	}
	if exists(filepath.Join(s.grokHome, "sessions")) {
		out = append(out, "grok")
	}
	if exists(GeminiDir(h, s.env)) {
		out = append(out, "gemini")
	}
	if exists(QwenDir(h, s.env)) {
		out = append(out, "qwen")
	}
	if exists(s.opencodeDb()) {
		out = append(out, "opencode")
	}
	if exists(s.copilotDb()) {
		out = append(out, "copilot")
	}
	for _, d := range KimiDirs(h, s.env) {
		if exists(filepath.Join(d, "sessions")) {
			out = append(out, "kimi")
			break
		}
	}
	if exists(filepath.Join(h, ".aider", "analytics.jsonl")) {
		out = append(out, "aider")
	}
	return out
}

func (s *UsageLogScanner) claudeDir() string {
	return filepath.Join(ClaudeConfigDir(s.home, s.env), "projects")
}
func (s *UsageLogScanner) codexDir() string {
	return filepath.Join(CodexHomeDir(s.home, s.env), "sessions")
}
func (s *UsageLogScanner) opencodeDb() string {
	return filepath.Join(OpencodeDir(s.home, s.env), "opencode.db")
}
func (s *UsageLogScanner) copilotDb() string {
	return filepath.Join(CopilotDir(s.home, s.env), "session-store.db")
}

var dshName = regexp.MustCompile(`^session(\.v\d+)?\.jsonl(\.zstd)?$`)

func (s *UsageLogScanner) find() []found {
	keep := RetentionMs[s.d.Retention()]
	since := s.now() - math.Min(keep, maxLookbackMs)
	out := []found{}
	seen := map[string]bool{}
	walk := func(dir string, pred func(n, full string) bool, depth int) []walkFile {
		return walkAsync(dir, pred, depth, since, s.dirCache, seen)
	}
	add := func(source, mode string, list []walkFile) {
		for _, f := range list {
			out = append(out, found{source, f.Path, f.Mtime, mode})
		}
	}
	jsonl := func(n, _ string) bool { return strings.HasSuffix(n, ".jsonl") }
	add("claude", "jsonl", walk(s.claudeDir(), jsonl, 4))
	add("codex", "jsonl", walk(s.codexDir(), jsonl, 4))
	dsh := walk(filepath.Join(s.dshHome, "sessions"), func(n, _ string) bool { return dshName.MatchString(n) }, 3)
	var plain, z []walkFile
	for _, f := range dsh {
		if strings.HasSuffix(f.Path, ".zstd") {
			z = append(z, f)
		} else {
			plain = append(plain, f)
		}
	}
	add("dsh", "jsonl", plain)
	add("dsh", "whole", z)
	add("grok", "jsonl", walk(filepath.Join(s.grokHome, "sessions"), func(n, _ string) bool { return n == "updates.jsonl" }, 4))
	add("gemini", "whole", walk(filepath.Join(GeminiDir(s.home, s.env), "tmp"), IsGeminiChatFile, 5))
	sep := string(filepath.Separator)
	add("qwen", "jsonl", walk(filepath.Join(QwenDir(s.home, s.env), "tmp"), func(n, full string) bool {
		return strings.HasSuffix(n, ".jsonl") && strings.Contains(full, sep+"chats"+sep)
	}, 4))
	for _, root := range KimiDirs(s.home, s.env) {
		add("kimi", "jsonl", walk(filepath.Join(root, "sessions"), func(n, _ string) bool { return n == "wire.jsonl" }, 6))
	}
	for _, sf := range [][2]string{{"opencode", s.opencodeDb()}, {"copilot", s.copilotDb()}} {
		if st := statOf(sf[1]); st != nil {
			add(sf[0], "db", []walkFile{{sf[1], mtimeMs(st)}})
		}
	}
	aider := filepath.Join(s.home, ".aider", "analytics.jsonl")
	if st := statOf(aider); st != nil && mtimeMs(st) >= since {
		add("aider", "jsonl", []walkFile{{aider, mtimeMs(st)}})
	}
	for d := range s.dirCache {
		if !seen[d] {
			delete(s.dirCache, d)
		}
	}
	return out
}

type ScanResult struct {
	Added float64 `json:"added"`
	Files float64 `json:"files"`
}

// Scan 扫描一轮；重入时直接返回 0。
func (s *UsageLogScanner) Scan() ScanResult {
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return ScanResult{}
	}
	s.running = true
	s.mu.Unlock()
	defer func() { s.mu.Lock(); s.running = false; s.mu.Unlock() }()
	var added, files float64
	s.d.Ledger.WhenReady()
	for _, f := range s.find() {
		if s.d.RouteBusy != nil && s.d.RouteBusy(f.source) {
			continue
		}
		n, err := func() (n float64, err error) {
			defer func() {
				if r := recover(); r != nil {
					err = fmt.Errorf("%v", r)
				}
			}()
			switch f.mode {
			case "jsonl":
				return s.readJsonl(f)
			case "db":
				return s.readDb(f), nil
			default:
				return s.readWhole(f)
			}
		}()
		if err != nil {
			if s.d.Logger != nil {
				s.d.Logger.Warn("usage scan file failed", map[string]any{"file": filepath.Base(f.path), "e": err.Error()})
			}
		} else {
			if n >= 0 {
				files++
			}
			added += math.Max(0, n)
		}
		tick()
	}
	return ScanResult{added, files}
}

func (s *UsageLogScanner) ingest(recs []UsageRecord) float64 {
	l := s.d.Ledger
	var n float64
	for i := range recs {
		r := &recs[i]
		cleared := 0.0
		if s.d.ClearedAt != nil {
			cleared = s.d.ClearedAt()
		}
		if r.Ts == 0 || r.Ts < cleared {
			continue
		}
		if r.Source == "claude" || r.Source == "codex" {
			same := l.Get(r.Key)
			var cover *UsageRecord
			if same != nil && same.Via == "route" {
				cover = same
			} else if same == nil {
				cover = l.RouteCovering(r.Source, r.Ts, &RouteHint{r.Key, r.Session, r.Input + r.CacheRead + r.CacheWrite, r.Output})
			}
			if cover != nil {
				p := AttributePatch{CacheWrite1h: r.CacheWrite1h, Fast: r.Fast != nil && *r.Fast}
				if r.Session != nil {
					p.Session = *r.Session
				}
				if r.Project != nil {
					p.Project = *r.Project
				}
				if cover.Key != r.Key {
					p.LogKey = r.Key
				}
				if l.Attribute(cover.Key, p) {
					n++
				}
				continue
			}
		}
		if l.Upsert(r) {
			n++
			if s.d.OnNew != nil {
				s.d.OnNew(r)
			}
		}
	}
	return n
}

func (s *UsageLogScanner) parseChunk(source, text string, state ParseState) []UsageRecord {
	switch source {
	case "claude":
		return ParseClaudeChunk(text)
	case "codex":
		if q := ParseCodexRateLimits(text); q != nil && s.d.OnQuota != nil {
			s.d.OnQuota(q)
		}
		return ParseCodexChunk(text, state)
	case "dsh":
		return ParseDshChunk(text, state)
	case "grok":
		return ParseGrokChunk(text, state)
	case "qwen":
		return ParseQwenChunk(text)
	case "kimi":
		return ParseKimiChunk(text, state)
	case "aider":
		return ParseAiderChunk(text)
	}
	return nil
}

func copyCursor(c *FileCursor) *FileCursor { x := *c; return &x }

func (s *UsageLogScanner) readJsonl(f found) (float64, error) {
	l := s.d.Ledger
	st := statOf(f.path)
	if st == nil {
		return -1, nil
	}
	size, mt := float64(st.Size()), mtimeMs(st)
	cur := l.Cursor(f.path)
	if cur != nil && size < cur.Offset {
		cur = nil
	}
	if cur != nil && identityChanged(cur, f.path, st) {
		cur = nil
	}
	if cur != nil && cur.Offset > 0 && (cur.Size != size || cur.MtimeMs != mt) {
		if !s.cursorStillValid(f.path, cur) {
			cur = nil
		}
	}
	if f.source == "grok" && (cur == nil || cur.State == nil || cur.State["rev"] != any(float64(grokLogRev))) {
		cur = nil
	}
	if cur != nil && cur.Offset >= size {
		if cur.Size != size || cur.MtimeMs != mt || ((cur.Fp == nil || *cur.Fp == "") && cur.Offset > 0) {
			fh, err := os.Open(f.path)
			if err != nil {
				return 0, err
			}
			id := fingerprintAt(fh, cur.Offset)
			fh.Close()
			next := copyCursor(cur)
			next.Size, next.MtimeMs = size, mt
			applyIdentity(next, f.path, st)
			applyFp(next, id)
			l.SetCursor(f.path, next)
		}
		return -1, nil
	}
	state := ParseState{}
	if cur != nil {
		for k, v := range cur.State {
			state[k] = v
		}
	}
	if f.source == "kimi" && !util.Truthy(state["sid"]) {
		if id := KimiSessionId(f.path); id != nil {
			state["sid"] = *id
		} else {
			delete(state, "sid")
		}
	}
	if f.source == "grok" {
		state["rev"] = float64(grokLogRev)
	}
	if f.source == "grok" && !util.Truthy(state["sid"]) {
		state["sid"] = filepath.Base(filepath.Dir(f.path))
		if c, err := util.DecodeURIComponent(filepath.Base(filepath.Dir(filepath.Dir(f.path)))); err == nil {
			state["cwd"] = c
		}
	}
	var startOffset float64
	if cur != nil {
		startOffset = cur.Offset
	}
	offset, readPos := startOffset, startOffset
	var pending []byte
	var added float64
	fh, err := os.Open(f.path)
	if err != nil {
		return 0, err
	}
	budget := float64(maxReadPerPass)
	for readPos < size && (budget > 0 || offset == startOffset) {
		ln := math.Min(readChunk, size-readPos)
		buf := make([]byte, int(ln))
		n, _ := fh.ReadAt(buf, int64(readPos))
		if n <= 0 {
			break
		}
		readPos += float64(n)
		budget -= float64(n)
		data := append(append([]byte{}, pending...), buf[:n]...)
		nl := lastNL(data)
		if nl < 0 {
			pending = data
			if len(pending) > maxWholeFile {
				offset = readPos
				pending = nil
			}
			continue
		}
		complete := data[:nl+1]
		pending = data[nl+1:]
		offset += float64(len(complete))
		added += s.ingest(s.parseChunk(f.source, charcontract.DecodeUTF8(complete), state))
		tick()
	}
	id := fingerprintAt(fh, offset)
	fh.Close()
	next := &FileCursor{Offset: offset, Size: size, MtimeMs: mt, State: state}
	applyIdentity(next, f.path, st)
	applyFp(next, id)
	l.SetCursor(f.path, next)
	return added, nil
}

func lastNL(b []byte) int {
	for i := len(b) - 1; i >= 0; i-- {
		if b[i] == 0x0a {
			return i
		}
	}
	return -1
}

func (s *UsageLogScanner) cursorStillValid(file string, cur *FileCursor) bool {
	if cur.Fp == nil || *cur.Fp == "" || cur.FpLen == nil || *cur.FpLen == 0 {
		return false
	}
	fh, err := os.Open(file)
	if err != nil {
		return false
	}
	defer fh.Close()
	now := fingerprintAt(fh, cur.Offset)
	return now != nil && now.fpLen == *cur.FpLen && now.fp == *cur.Fp
}

func (s *UsageLogScanner) readWhole(f found) (float64, error) {
	l := s.d.Ledger
	st := statOf(f.path)
	if st == nil {
		return -1, nil
	}
	size, mt := float64(st.Size()), mtimeMs(st)
	cur := l.Cursor(f.path)
	if cur != nil && cur.Size == size && cur.MtimeMs == mt {
		return -1, nil
	}
	if size > maxWholeFile {
		l.SetCursor(f.path, &FileCursor{Offset: size, Size: size, MtimeMs: mt})
		return -1, nil
	}
	var recs []UsageRecord
	if f.source == "gemini" {
		b, err := os.ReadFile(f.path)
		if err != nil {
			return 0, err
		}
		base := jsonlExt.ReplaceAllString(filepath.Base(f.path), "")
		recs = ParseGeminiFile(charcontract.DecodeUTF8(b), geminiProject(f.path), &base)
	} else if f.source == "dsh" {
		b, err := os.ReadFile(f.path)
		if err != nil {
			return 0, err
		}
		if s.d.ZstdDecode == nil {
			return 0, fmt.Errorf("zstd decoder not configured")
		}
		text, err := s.d.ZstdDecode(b)
		if err != nil {
			return 0, err
		}
		recs = ParseDshChunk(text, ParseState{})
	}
	added := s.ingest(recs)
	l.SetCursor(f.path, &FileCursor{Offset: size, Size: size, MtimeMs: mt})
	return added, nil
}

// jsNumOr0 = Number(v) || 0（sqlite 行值：float64 / string / nil）
func jsNumOr0(v any) float64 {
	var n float64
	switch x := v.(type) {
	case float64:
		n = x
	case string:
		n = util.ToNumber(x)
	case bool:
		if x {
			n = 1
		}
	}
	if math.IsNaN(n) {
		return 0
	}
	return n
}

func (s *UsageLogScanner) readDb(f found) float64 {
	l := s.d.Ledger
	sig, ok := DBSignature(f.path)
	if !ok {
		return -1
	}
	cur := l.Cursor(f.path)
	var prev map[string]any
	if cur != nil {
		prev = cur.State
	}
	if ps, ok := prev["sig"].(string); ok && ps == sig {
		return -1
	}
	keep := RetentionMs[s.d.Retention()]
	since := s.now() - math.Min(keep, maxLookbackMs)
	var recs []UsageRecord
	last := 0.0
	if v, ok := prev["last"].(float64); ok {
		last = v
	}
	full := false
	if f.source == "opencode" {
		from := last
		if from == 0 {
			from = since
		}
		rows := ReadOpencodeRows(f.path, math.Max(0, from))
		full = len(rows) >= DBBatch
		for _, r := range rows {
			if rec := OpencodeRowToRecord(r); rec != nil && rec.Ts >= since {
				recs = append(recs, *rec)
			}
			last = math.Max(last, jsNumOr0(r.Get("updated")))
		}
	} else if f.source == "copilot" {
		rows := ReadCopilotRows(f.path, last)
		full = len(rows) >= DBBatch
		for _, r := range rows {
			if rec := CopilotRowToRecord(r); rec != nil && rec.Ts >= since {
				recs = append(recs, *rec)
			}
			last = math.Max(last, jsNumOr0(r.Get("id")))
		}
	}
	added := s.ingest(recs)
	st := statOf(f.path)
	next := &FileCursor{}
	if st != nil {
		next.Offset, next.Size, next.MtimeMs = float64(st.Size()), float64(st.Size()), mtimeMs(st)
	}
	if full {
		next.State = map[string]any{"last": last}
	} else {
		next.State = map[string]any{"sig": sig, "last": last}
	}
	l.SetCursor(f.path, next)
	tick()
	return added
}
