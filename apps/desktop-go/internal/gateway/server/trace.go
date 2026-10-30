package server

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/privacy"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// TraceMaxAgeMs is TRACE_MAX_AGE_MS.
const TraceMaxAgeMs = 24 * 60 * 60 * 1000

// TraceMaxBodyChars is TRACE_MAX_BODY_CHARS.
const TraceMaxBodyChars = 2_000_000

const pruneIntervalMs = 10 * 60 * 1000

const redacted = "[REDACTED]"

var redactedUnits = u.ToUnits(redacted)

var secretField = regexp.MustCompile(`(?i)^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-goog-api-key|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|session[-_]?token|token|secret|client[-_]?secret|password|private[-_]?key|device[-_]?code|user[-_]?code|auth(?:orization)?[-_]?code|code[-_]?verifier)$`)

// IsSecretField is SECRET_FIELD.test(k) (JS non-unicode /i: ASCII folding only).
func IsSecretField(k string) bool { return secretField.MatchString(u.Projection(u.ToUnits(k))) }

var secretPatterns = []*regexp.Regexp{
	privacy.JSRegexp(`(?i)\b(Bearer)\s+[A-Za-z0-9._~+/=-]{6,}`),
	privacy.JSRegexp(`\bsk-[A-Za-z0-9_-]{8,}`),
	privacy.JSRegexp(`\bAIza[0-9A-Za-z_-]{20,}`),
	privacy.JSRegexp(`\b(xai|gsk|ghp|gho|github_pat|glpat|hf)_[A-Za-z0-9_]{12,}`),
	privacy.JSRegexp(`(?i)([?&](?:key|api_key|access_token|refresh_token|token|code|code_verifier|client_secret)=)[^&\s"']+`),
	privacy.JSRegexp(`\bnomi-(?:gw|tab)-[A-Za-z0-9_-]{6,}`),
	privacy.JSRegexp(`(?i)((?:user|device)[ _-]?code["']?\s*[:=]\s*["']?)[A-Z0-9]{4}-[A-Z0-9]{4,}`),
}

var (
	reQA     = regexp.MustCompile(`^[?&]`)
	reCode   = regexp.MustCompile(`(?i)code`)
	reBearer = regexp.MustCompile(`(?i)^Bearer$`)
)

// RedactText is redactText(text, secrets).
func RedactText(text string, secrets []string) string {
	return u.FromUnits(redactUnits(u.ToUnits(text), secrets))
}

func redactUnits(out u.Units, secrets []string) u.Units {
	for _, s := range secrets {
		su := u.ToUnits(s)
		if len(su) >= 6 {
			out = u.ReplaceAllUnits(out, su, redactedUnits)
		}
	}
	if spans := privacy.RuleSpans(u.FromUnits(out), false); len(spans) > 0 {
		acc := make(u.Units, 0, len(out))
		at := 0
		for _, sp := range privacy.MergeSpans(spans) {
			if sp.Start > at {
				acc = append(acc, out[at:sp.Start]...)
			} else if sp.Start < at {
				// JS slice(at, start) with start < at is ''
			}
			acc = append(acc, redactedUnits...)
			at = sp.End
		}
		if at < len(out) {
			acc = append(acc, out[at:]...)
		}
		out = acc
	}
	for _, re := range secretPatterns {
		proj := u.Projection(out)
		ms := re.FindAllStringSubmatchIndex(proj, -1)
		if ms == nil {
			continue
		}
		acc := make(u.Units, 0, len(out))
		last := 0
		for _, m := range ms {
			acc = append(acc, out[last:m[0]]...)
			if len(m) >= 4 && m[2] >= 0 {
				p1 := out[m[2]:m[3]]
				pp := proj[m[2]:m[3]]
				switch {
				case reQA.MatchString(pp) || reCode.MatchString(pp):
					acc = append(acc, p1...)
					acc = append(acc, redactedUnits...)
				case reBearer.MatchString(pp):
					acc = append(acc, p1...)
					acc = append(acc, ' ')
					acc = append(acc, redactedUnits...)
				default:
					acc = append(acc, redactedUnits...)
				}
			} else {
				acc = append(acc, redactedUnits...)
			}
			last = m[1]
		}
		out = append(acc, out[last:]...)
	}
	return out
}

// RedactJSON is redactJson(v, secrets).
func RedactJSON(v any, secrets []string) any { return redactJSON(v, secrets, 0) }

func redactJSON(v any, secrets []string, depth int) any {
	if depth > 64 {
		return "[…]"
	}
	switch x := v.(type) {
	case string:
		return RedactText(x, secrets)
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = redactJSON(e, secrets, depth+1)
		}
		return out
	case *u.Obj:
		if x == nil {
			return nil
		}
		out := u.NewObj()
		for _, k := range x.Keys() {
			e := x.Get(k)
			var y any
			switch e.(type) {
			case string, float64, int:
				if IsSecretField(k) {
					y = redacted
				} else {
					y = redactJSON(e, secrets, depth+1)
				}
			default:
				y = redactJSON(e, secrets, depth+1)
			}
			if k == "__proto__" {
				continue // out['__proto__'] = y never makes an own key
			}
			out.Set(k, y)
		}
		return out
	}
	return v
}

// RedactHeaders is redactHeaders(h, secrets): values are string or []string
// (nil entries are undefined and skipped).
func RedactHeaders(h *u.Obj, secrets []string) *u.Obj {
	out := u.NewObj()
	for _, k := range h.Keys() {
		var s string
		switch v := h.Get(k).(type) {
		case nil:
			continue
		case string:
			s = v
		case []string:
			s = strings.Join(v, ", ")
		case []any:
			parts := make([]string, len(v))
			for i, e := range v {
				if e != nil {
					parts[i] = u.JSString(e)
				}
			}
			s = strings.Join(parts, ", ")
		default:
			s = u.JSString(v)
		}
		if k == "__proto__" {
			continue
		}
		if IsSecretField(k) {
			out.Set(k, redacted)
		} else {
			out.Set(k, RedactText(s, secrets))
		}
	}
	return out
}

func sortByLenDesc(xs []string) {
	sort.SliceStable(xs, func(i, j int) bool { return u.UTF16Len(xs[i]) > u.UTF16Len(xs[j]) })
}

// SecretsOf is secretsOf(cfg).
func SecretsOf(cfg *config.GatewayConfig) []string {
	var out []string
	// 按下标取，不按值拷贝 RuntimeProvider（同 privacy.KnownSecrets：拷贝会读 memo 指针，
	// 与并发请求在 Memo() 里的写竞争）。
	for i := range cfg.Providers {
		for _, k := range cfg.Providers[i].Keys {
			if k.Value != "" {
				out = append(out, k.Value)
			}
		}
	}
	for _, c := range cfg.ClientValues() {
		if c != nil && c.Token != "" {
			out = append(out, c.Token)
		}
	}
	if cfg.LegacyToken != "" {
		out = append(out, cfg.LegacyToken)
	}
	if cfg.Privacy != nil {
		for _, k := range cfg.Privacy.Known {
			if k.Value != "" {
				out = append(out, k.Value)
			}
		}
	}
	sortByLenDesc(out)
	if out == nil {
		out = []string{}
	}
	return out
}

const diffMaxBlocks = 200

var blockSep = regexp.MustCompile(`\r?\n\r?\n`)

func blocksOf(text string) []string {
	if !blockSep.MatchString(text) {
		if t := u.JSTrim(text); t != "" {
			return []string{t}
		}
		return nil
	}
	var out []string
	for _, b := range blockSep.Split(text, -1) {
		if t := u.JSTrim(b); t != "" {
			out = append(out, t)
		}
	}
	return out
}

// TraceDiffResult is traceDiff's result.
type TraceDiffResult struct {
	Added, Dropped           []string
	AddedTotal, DroppedTotal int
}

// Obj renders the JS object (key order added, dropped, addedTotal, droppedTotal).
func (d *TraceDiffResult) Obj() *u.Obj {
	return u.NewObj("added", strs(d.Added), "dropped", strs(d.Dropped), "addedTotal", float64(d.AddedTotal), "droppedTotal", float64(d.DroppedTotal))
}

func strs(xs []string) []any {
	out := make([]any, len(xs))
	for i, x := range xs {
		out[i] = x
	}
	return out
}

// TraceDiff is traceDiff(upstream, client); nil when there is no difference.
func TraceDiff(upstream, client string) *TraceDiffResult {
	if upstream == client {
		return nil
	}
	var order []string
	count := map[string]int{}
	for _, b := range blocksOf(upstream) {
		if _, ok := count[b]; !ok {
			order = append(order, b)
		}
		count[b]++
	}
	added := []string{}
	for _, b := range blocksOf(client) {
		if n := count[b]; n > 0 {
			count[b] = n - 1
		} else {
			added = append(added, b)
		}
	}
	dropped := []string{}
	for _, b := range order {
		for i := 0; i < count[b]; i++ {
			dropped = append(dropped, b)
		}
	}
	if len(added) == 0 && len(dropped) == 0 {
		return nil
	}
	return &TraceDiffResult{Added: added[:min(len(added), diffMaxBlocks)], Dropped: dropped[:min(len(dropped), diffMaxBlocks)], AddedTotal: len(added), DroppedTotal: len(dropped)}
}

func clip(s string) string {
	us := u.ToUnits(s)
	if len(us) > TraceMaxBodyChars {
		return u.FromUnits(us[:TraceMaxBodyChars]) + "…[truncated " + strconv.Itoa(len(us)-TraceMaxBodyChars) + " chars]"
	}
	return s
}

// PruneTracesNow is pruneTraces(dir) with the default now and max age.
func PruneTracesNow(dir string) int {
	return PruneTraces(dir, float64(time.Now().UnixMilli()), TraceMaxAgeMs)
}

// PruneTraces is pruneTraces(dir, now, maxAgeMs).
func PruneTraces(dir string, now float64, maxAgeMs float64) int {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	removed := 0
	for _, e := range ents {
		n := e.Name()
		if !strings.HasSuffix(n, ".json") && !strings.HasSuffix(n, ".tmp") {
			continue
		}
		f := filepath.Join(dir, n)
		st, err := os.Stat(f)
		if err != nil {
			continue
		}
		mtime := float64(st.ModTime().UnixNano()) / 1e6
		if now-mtime > maxAgeMs {
			if err := os.RemoveAll(f); err == nil {
				removed++
			}
		}
	}
	return removed
}

var (
	lastPruneMu sync.Mutex
	lastPrune   = map[string]float64{}
)

// TraceStamp is traceStamp(ts).
func TraceStamp(ts float64) string {
	s, _ := u.ToISOString(ts)
	return strings.NewReplacer(":", "-", ".", "-").Replace(s)
}

// TraceMeta is the meta argument of RequestTrace.
type TraceMeta struct {
	Client, Ingress, Path string
	StartedAt             float64
}

// WarnLogger is the logger shape trace needs.
type WarnLogger interface{ Warn(msg string, d any) }

// TraceOpts is RequestTrace's opts.
type TraceOpts struct {
	Logger WarnLogger
	Now    func() float64
	ID     string
}

// RequestTrace is RequestTrace.
type RequestTrace struct {
	dir            string
	meta           TraceMeta
	opts           TraceOpts
	secrets        []string
	attempts       []*u.Obj
	requestHeaders *u.Obj
	requestBody    any
	hasBody        bool
	responseText   strings.Builder
	responseLen    int
	clientText     strings.Builder
	clientLen      int
	responseStatus *int
	done           bool
	mu             sync.Mutex
	ID             string
}

func randomID() string {
	var b [6]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// NewRequestTrace is new RequestTrace(dir, cfg, meta, opts).
func NewRequestTrace(dir string, cfg *config.GatewayConfig, meta TraceMeta, opts TraceOpts) *RequestTrace {
	t := &RequestTrace{dir: dir, meta: meta, opts: opts, secrets: SecretsOf(cfg), requestHeaders: u.NewObj()}
	t.ID = opts.ID
	if t.ID == "" {
		t.ID = randomID()
	}
	return t
}

// AddSecrets is addSecrets(values).
func (t *RequestTrace) AddSecrets(values []string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	seen := map[string]bool{}
	var list []string
	add := func(v string) {
		if !seen[v] {
			seen[v] = true
			list = append(list, v)
		}
	}
	for _, v := range t.secrets {
		add(v)
	}
	for _, v := range values {
		if v != "" {
			add(v)
		}
	}
	sortByLenDesc(list)
	t.secrets = list
}

// Request is request(headers, body); hasBody=false is body undefined.
func (t *RequestTrace) Request(headers *u.Obj, body any, hasBody bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.requestHeaders = RedactHeaders(headers, t.secrets)
	t.requestBody, t.hasBody = body, hasBody
}

// Attempt is attempt(a): a is the attempt object in its JS literal key order
// (provider, key?, wire, url, headers? as *u.Obj, body?, status?, error?).
func (t *RequestTrace) Attempt(a *u.Obj) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.attempts = append(t.attempts, a)
}

// AttemptResult is attemptResult(status, error).
func (t *RequestTrace) AttemptResult(status int, errText string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.attempts) == 0 {
		return
	}
	last := t.attempts[len(t.attempts)-1]
	last.Set("status", float64(status))
	if errText != "" {
		last.Set("error", errText)
	}
}

// Response is response(status, chunk).
func (t *RequestTrace) Response(status int, chunk string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.responseStatus = &status
	if t.responseLen <= TraceMaxBodyChars {
		t.responseText.WriteString(chunk)
		t.responseLen += u.UTF16Len(chunk)
	}
}

// Client is client(chunk).
func (t *RequestTrace) Client(chunk string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.clientLen <= TraceMaxBodyChars {
		t.clientText.WriteString(chunk)
		t.clientLen += u.UTF16Len(chunk)
	}
}

// Finish is finish(result): result is the JS object in its literal key order
// (status, ms, attempts, usage?, error?, notes?). Returns the file written or "".
// A non-nil error is the RangeError Node's finish() rejects with (invalid startedAt).
func (t *RequestTrace) Finish(result *u.Obj) (string, error) {
	t.mu.Lock()
	if t.done {
		t.mu.Unlock()
		return "", nil
	}
	t.done = true
	s := t.secrets
	respText := u.JSConcat(t.responseText.String())
	clientText := u.JSConcat(t.clientText.String())
	diff := TraceDiff(respText, clientText)
	doc := u.NewObj("version", float64(2), "traceId", t.ID, "client", t.meta.Client, "ingress", t.meta.Ingress,
		"path", RedactText(t.meta.Path, s))
	started, ok := u.ToISOString(t.meta.StartedAt)
	if !ok {
		t.mu.Unlock()
		return "", ErrInvalidTime
	}
	doc.Set("startedAt", started)
	for _, k := range result.Keys() {
		doc.Set(k, result.Get(k))
	}
	if e, _ := result.Get("error").(string); e != "" {
		doc.Set("error", RedactText(e, s))
	} else {
		doc.Delete("error")
	}
	req := u.NewObj("headers", t.requestHeaders)
	if t.hasBody {
		req.Set("body", RedactJSON(t.requestBody, s))
	}
	doc.Set("request", req)
	ups := make([]any, 0, len(t.attempts))
	for _, a := range t.attempts {
		o := a.Clone()
		url, _ := a.Get("url").(string)
		o.Set("url", RedactText(url, s))
		if h, ok := a.Get("headers").(*u.Obj); ok && h != nil {
			o.Set("headers", RedactHeaders(h, s))
		} else {
			o.Delete("headers")
		}
		if a.Has("body") {
			o.Set("body", RedactJSON(a.Get("body"), s))
		}
		if e, _ := a.Get("error").(string); e != "" {
			o.Set("error", clip(RedactText(e, s)))
		} else {
			o.Delete("error")
		}
		ups = append(ups, o)
	}
	doc.Set("upstream", ups)
	resp := u.NewObj()
	if t.responseStatus != nil {
		resp.Set("status", float64(*t.responseStatus))
	}
	resp.Set("body", clip(RedactText(respText, s)))
	doc.Set("response", resp)
	if diff != nil {
		d := &TraceDiffResult{AddedTotal: diff.AddedTotal, DroppedTotal: diff.DroppedTotal}
		for _, b := range diff.Added {
			d.Added = append(d.Added, clip(RedactText(b, s)))
		}
		for _, b := range diff.Dropped {
			d.Dropped = append(d.Dropped, clip(RedactText(b, s)))
		}
		doc.Set("clientOutput", d.Obj())
	} else {
		doc.Set("clientOutput", "same-as-upstream")
	}
	t.mu.Unlock()

	base := TraceStamp(t.meta.StartedAt) + "-" + SafeClient(t.meta.Client) + "-" + t.ID
	data := u.StringifyIndent(doc, "  ")
	file, err := t.write(base, data)
	if err != nil {
		if t.opts.Logger != nil {
			t.opts.Logger.Warn("gateway trace write failed", u.NewObj("error", err.Error()))
		}
		return "", nil
	}
	t.maybePrune()
	return file, nil
}

var unsafeClient = regexp.MustCompile(`[^A-Za-z0-9_-]`)

// SafeClient is client.replace(/[^A-Za-z0-9_-]/g, '_') over UTF-16 units.
func SafeClient(c string) string {
	us := u.ToUnits(c)
	b := make([]byte, len(us))
	for i, x := range us {
		if x < 0x80 && !unsafeClient.MatchString(string(rune(x))) {
			b[i] = byte(x)
		} else {
			b[i] = '_'
		}
	}
	return string(b)
}

func (t *RequestTrace) write(base, data string) (string, error) {
	if err := os.MkdirAll(t.dir, 0o700); err != nil {
		return "", err
	}
	var file string
	for i := 0; i < 20; i++ {
		if i > 0 {
			file = filepath.Join(t.dir, base+"-"+strconv.Itoa(i+1)+".json")
		} else {
			file = filepath.Join(t.dir, base+".json")
		}
		tmp := file + "." + strconv.Itoa(os.Getpid()) + "." + strconv.Itoa(i) + ".tmp"
		err := os.WriteFile(tmp, []byte(data), 0o600)
		if err == nil {
			err = os.Link(tmp, file)
		}
		_ = os.Remove(tmp)
		if err == nil {
			return file, nil
		}
		if !errors.Is(err, os.ErrExist) || i == 19 {
			return "", err
		}
	}
	return file, nil
}

func (t *RequestTrace) maybePrune() {
	now := float64(time.Now().UnixMilli())
	if t.opts.Now != nil {
		now = t.opts.Now()
	}
	lastPruneMu.Lock()
	if now-lastPrune[t.dir] < pruneIntervalMs {
		lastPruneMu.Unlock()
		return
	}
	lastPrune[t.dir] = now
	lastPruneMu.Unlock()
	PruneTraces(t.dir, now, TraceMaxAgeMs)
}

// ErrInvalidTime is Node's RangeError("Invalid time value") from toISOString.
var ErrInvalidTime = errors.New("Invalid time value")

// StartTrace is startTrace(cfg, meta, logger).
func StartTrace(cfg *config.GatewayConfig, meta TraceMeta, logger WarnLogger) *RequestTrace {
	if cfg.TraceDir == "" {
		return nil
	}
	return NewRequestTrace(cfg.TraceDir, cfg, meta, TraceOpts{Logger: logger})
}
