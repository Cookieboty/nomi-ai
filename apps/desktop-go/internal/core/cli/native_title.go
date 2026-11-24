package cli

import (
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/agents"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const nativeTitleTailBytes = 256 * 1024

// LookupNativeSessionTitle resolves a CLI-generated native title or summary
// from local CLI storage without scanning unrelated backends.
func LookupNativeSessionTitle(backend, sessionID, configDir string) string {
	return lookupNativeSessionTitle(usage.Homedir(), backend, sessionID, configDir)
}

func lookupNativeSessionTitle(home, backend, sessionID, configDir string) string {
	sid := strings.TrimSpace(sessionID)
	cfgDir := strings.TrimSpace(configDir)
	if !isSafeLookupSessionID(sid) {
		return ""
	}
	env := usage.ProcessEnv()
	switch backend {
	case "claude":
		return lookupClaudeNativeTitle(home, env, sid, cfgDir)
	case "codex":
		return lookupCodexNativeTitle(home, env, sid, cfgDir)
	case "gemini":
		return lookupGeminiNativeTitle(home, env, sid, cfgDir)
	case "dsh":
		return lookupDshNativeTitle(home, env, sid, cfgDir)
	case "grok":
		return lookupGrokNativeTitle(home, env, sid, cfgDir)
	default:
		return ""
	}
}

func isSafeLookupSessionID(sessionID string) bool {
	if sessionID == "" || sessionID == "." || sessionID == ".." {
		return false
	}
	return !strings.ContainsAny(sessionID, "/\\\x00") && !strings.Contains(sessionID, "..")
}

func cleanNativeTitle(raw string) string {
	if p := cleanTitle80(raw); p != nil {
		return *p
	}
	return ""
}

func lookupClaudeNativeTitle(home string, env *util.Obj, sessionID, configDir string) string {
	hist := historyScan("claude")
	if hist == nil {
		return ""
	}
	root := filepath.Join(usage.ClaudeConfigDir(home, env), "projects")
	if configDir != "" {
		root = filepath.Join(configDir, "projects")
	}
	wantName := sessionID + ".jsonl"
	var matches []clisdk.HistoryFileRef
	for _, f := range hist.Scan(root) {
		if filepath.Base(f.Path) == wantName {
			matches = append(matches, f)
		}
	}
	if len(matches) == 0 {
		return ""
	}
	sort.SliceStable(matches, func(i, j int) bool { return matches[j].Mtime-matches[i].Mtime < 0 })
	head := shReadHead(matches[0].Path, 128*1024)
	tail, _, _ := shReadTailText(matches[0].Path, nativeTitleTailBytes)
	return cleanNativeTitle(agents.ParseClaudeSession(head, tail).NativeTitle)
}

func lookupCodexNativeTitle(home string, env *util.Obj, sessionID, configDir string) string {
	codexDir := configDir
	if codexDir == "" {
		codexDir = usage.CodexHomeDir(home, env)
	}
	dbPath := filepath.Join(codexDir, "state_5.sqlite")
	if !shExists(dbPath) {
		return ""
	}
	colRows := usage.SelectRows(dbPath, `SELECT name FROM pragma_table_info('threads')`)
	hasCol := map[string]bool{}
	for _, r := range colRows {
		if n, ok := r.Get("name").(string); ok {
			hasCol[n] = true
		}
	}
	if !hasCol["id"] {
		return ""
	}
	cols := []string{"id"}
	for _, c := range []string{"name", "title", "first_user_message"} {
		if hasCol[c] {
			cols = append(cols, c)
		}
	}
	if len(cols) == 1 {
		return ""
	}
	rows := usage.SelectRows(dbPath, `SELECT `+strings.Join(cols, ", ")+` FROM threads WHERE id = ? LIMIT 1`, sessionID)
	if len(rows) == 0 {
		return ""
	}
	row := rows[0]
	if name := cleanNativeTitle(shRowStr(row, "name")); name != "" {
		return name
	}
	title := cleanNativeTitle(shRowStr(row, "title"))
	if title == "" {
		return ""
	}
	firstUser := cleanNativeTitle(shRowStr(row, "first_user_message"))
	if firstUser != "" && title == firstUser {
		return ""
	}
	return title
}

func lookupGeminiNativeTitle(home string, env *util.Obj, sessionID, configDir string) string {
	hist := historyScan("gemini")
	if hist == nil {
		return ""
	}
	roots := []string{}
	seenRoot := map[string]bool{}
	addRoot := func(dir string) {
		if dir == "" {
			return
		}
		clean := filepath.Clean(dir)
		key := shPathKey(clean)
		if !seenRoot[key] {
			seenRoot[key] = true
			roots = append(roots, clean)
		}
	}
	if configDir != "" {
		addRoot(filepath.Join(configDir, ".gemini", "tmp"))
		addRoot(filepath.Join(configDir, "tmp"))
	} else {
		addRoot(filepath.Join(usage.GeminiDir(home, env), "tmp"))
	}
	var cands []clisdk.HistoryFileRef
	seenFile := map[string]bool{}
	for _, root := range roots {
		for _, f := range hist.Scan(root) {
			k := shPathKey(f.Path)
			if !seenFile[k] {
				seenFile[k] = true
				cands = append(cands, f)
			}
		}
	}
	sort.SliceStable(cands, func(i, j int) bool { return cands[j].Mtime-cands[i].Mtime < 0 })
	const geminiTitleMaxBytes = 4 * 1024 * 1024
	for _, f := range cands {
		if f.Size > geminiTitleMaxBytes {
			continue
		}
		raw := shReadHead(f.Path, geminiTitleMaxBytes)
		if raw == "" || !strings.Contains(raw, sessionID) {
			continue
		}
		info := agents.ParseGeminiSession(raw)
		if info.SessionID == sessionID {
			return cleanNativeTitle(info.NativeTitle)
		}
	}
	return ""
}

func lookupDshNativeTitle(home string, env *util.Obj, sessionID, configDir string) string {
	dshHome := configDir
	if dshHome == "" {
		if v, ok := os.LookupEnv("DSH_HOME"); ok && util.JSTrim(v) != "" {
			dshHome, _ = filepath.Abs(v)
		} else if env != nil {
			if s, ok := env.Get("DSH_HOME").(string); ok && util.JSTrim(s) != "" {
				dshHome, _ = filepath.Abs(s)
			}
		}
	}
	if dshHome == "" {
		dshHome = filepath.Join(home, ".dsh")
	}
	projFile := filepath.Join(dshHome, "storages", "session_projcache", "sessions", sessionID+".json")
	if raw := shReadHead(projFile, 256*1024); raw != "" {
		if nt := cleanNativeTitle(agents.ParseDshProjcache(raw).NativeTitle); nt != "" {
			return nt
		}
	}
	hist := builtin.Impl("dsh").History
	if hist == nil {
		return ""
	}
	var matches []clisdk.HistoryFileRef
	for _, f := range hist.Scan(filepath.Join(dshHome, "sessions")) {
		id := f.DirID
		if id == "" {
			id = filepath.Base(filepath.Dir(f.Path))
		}
		if id == sessionID {
			matches = append(matches, f)
		}
	}
	if len(matches) == 0 {
		return ""
	}
	sort.SliceStable(matches, func(i, j int) bool { return matches[j].Mtime-matches[i].Mtime < 0 })
	raw := ""
	f := matches[0]
	if strings.HasSuffix(f.Path, ".zstd") {
		if f.Size <= DshMetaMaxZstdBytes {
			if b, err := os.ReadFile(f.Path); err == nil {
				if x, err := ZstdDecode(b, ZstdMaxOutputBytes); err == nil {
					raw = util.UTF16Slice0(x, 512*1024)
				}
			}
		}
	} else {
		raw = shReadHead(f.Path, 512*1024)
		if tail, truncated, err := shReadTailText(f.Path, nativeTitleTailBytes); err == nil && truncated && tail != "" {
			raw = raw + "\n" + tail
		}
	}
	if raw == "" {
		return ""
	}
	return cleanNativeTitle(agents.ParseDshSession(raw, sessionID).NativeTitle)
}

func lookupGrokNativeTitle(home string, env *util.Obj, sessionID, configDir string) string {
	hist := historyScan("grok")
	if hist == nil {
		return ""
	}
	grokHome := configDir
	if grokHome == "" {
		grokHome = usage.GrokHomeDir(home, env)
	}
	var matches []clisdk.HistoryFileRef
	for _, f := range hist.Scan(filepath.Join(grokHome, "sessions")) {
		id := f.DirID
		if id == "" {
			id = filepath.Base(filepath.Dir(f.Path))
		}
		if id == sessionID {
			matches = append(matches, f)
		}
	}
	if len(matches) == 0 {
		return ""
	}
	sort.SliceStable(matches, func(i, j int) bool { return matches[j].Mtime-matches[i].Mtime < 0 })
	path := matches[0].Path
	text := shReadHead(path, 512*1024)
	if tail, truncated, err := shReadTailText(path, nativeTitleTailBytes); err == nil && truncated && tail != "" {
		text = text + "\n" + tail
	}
	if text == "" {
		return ""
	}
	return cleanNativeTitle(agents.ParseGrokSession(text, sessionID).NativeTitle)
}
