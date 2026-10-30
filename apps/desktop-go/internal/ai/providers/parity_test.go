package providers

// 回放 scripts/parity/airuntime.mjs 录制的 testdata/parity/providers.json.gz，任何不一致都失败。
// 重新录制：TZ=Asia/Shanghai node scripts/parity/airuntime.mjs

import (
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/providers/protocol"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/runtime"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func loadFixture(t *testing.T) *u.Obj {
	t.Helper()
	f, err := os.Open("testdata/parity/providers.json.gz")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	zr, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	b, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	v, err := u.Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	return v.(*u.Obj)
}

type tally struct{ pass, fail int }

func (c *tally) eq(t *testing.T, what string, got, want any) {
	t.Helper()
	g, w := u.Stringify(got), u.Stringify(want)
	if g == w {
		c.pass++
		return
	}
	c.fail++
	if c.fail <= 20 {
		t.Errorf("%s mismatch\n got: %s\nwant: %s", what, g, w)
	}
}

func arr(v any) []any { a, _ := v.([]any); return a }

func strOr(v any) string { s, _ := v.(string); return s }

func TestProvidersParity(t *testing.T) {
	d := loadFixture(t)
	var c tally
	pr := u.AsObj(d.Get("protocol"))
	for i, e := range arr(pr.Get("proto")) {
		o := u.AsObj(e)
		p, b, f := strOr(o.Get("protocol")), strOr(o.Get("base")), o.Get("fullUrl") == true
		got := u.NewObj("protocol", p, "base", b, "fullUrl", f,
			"sdk", protocol.SdkBaseURL(p, b, f), "endpoint", protocol.EndpointURL(p, b, f), "models", protocol.ModelsURL(p, b, f))
		c.eq(t, fmt.Sprintf("proto[%d]", i), got, o)
	}
	for i, e := range arr(pr.Get("headers")) {
		o := u.AsObj(e)
		var extra *u.Obj
		if x, ok := o.Get("extra").(*u.Obj); ok {
			extra = x
		}
		c.eq(t, fmt.Sprintf("headers[%d]", i), protocol.ModelsRequestHeaders(strOr(o.Get("protocol")), strOr(o.Get("key")), extra), o.Get("out"))
	}
	for i, e := range arr(pr.Get("parsed")) {
		o := u.AsObj(e)
		c.eq(t, fmt.Sprintf("parsed[%d]", i), u.NewObj("ok", true, "v", protocol.ParseModelList(o.Get("in"))), o.Get("out"))
	}
	for i, e := range arr(pr.Get("maps")) {
		o := u.AsObj(e)
		c.eq(t, fmt.Sprintf("maps[%d]", i), protocol.MapModel(strOr(o.Get("model")), arr(o.Get("map"))), o.Get("out"))
	}
	c.eq(t, "labels", protocol.ProtocolLabels(), pr.Get("labels"))
	for i, e := range arr(d.Get("masks")) {
		o := u.AsObj(e)
		c.eq(t, fmt.Sprintf("masks[%d]", i), MaskSecret(strOr(o.Get("in"))), o.Get("out"))
	}
	for i, e := range arr(d.Get("searches")) {
		o := u.AsObj(e)
		ids := []any{}
		for _, p := range SearchPresets(strOr(o.Get("q")), nil) {
			ids = append(ids, p.Get("id"))
		}
		c.eq(t, fmt.Sprintf("searches[%d]", i), ids, o.Get("ids"))
	}
	c.eq(t, "categories", PresetCategoryLabels(), d.Get("categories"))
	for i, e := range arr(d.Get("envs")) {
		o := u.AsObj(e)
		env := envOf(o.Get("env"))
		var override any = runtime.ProviderOverrideFromEnv(env)
		if override == "" {
			override = nil
		}
		got := u.NewObj("env", o.Get("env"), "entries", entriesJSON(env), "override", override)
		c.eq(t, fmt.Sprintf("envs[%d]", i), got, o)
	}
	for i, e := range arr(d.Get("migrate")) {
		o := u.AsObj(e)
		raw, _ := u.ParseString(u.Stringify(o.Get("raw")))
		data, migrated, err := MigrateStoreData(raw)
		if err != nil {
			t.Fatalf("migrate[%d]: %v", i, err)
		}
		c.eq(t, fmt.Sprintf("migrate[%d]", i), u.NewObj("data", data, "migrated", migrated), o.Get("out"))
	}
	for _, r := range arr(d.Get("runs")) {
		ro := u.AsObj(r)
		steps := replay(t, ro)
		want := arr(ro.Get("steps"))
		if len(steps) != len(want) {
			t.Errorf("run %v: %d steps, want %d", ro.Get("name"), len(steps), len(want))
			c.fail++
			continue
		}
		for i := range steps {
			c.eq(t, fmt.Sprintf("run %v step %d (%v)", ro.Get("name"), i, u.AsObj(want[i]).Get("op")), steps[i], want[i])
		}
	}
	t.Logf("providers parity: pass=%d fail=%d", c.pass, c.fail)
	if c.fail > 0 {
		t.Fatalf("providers parity: %d mismatches", c.fail)
	}
}

func envOf(v any) runtime.EnvLike {
	env := runtime.EnvLike{}
	o := u.AsObj(v)
	for _, k := range o.Keys() {
		env[k] = strOr(o.Get(k))
	}
	return env
}

func entriesJSON(env runtime.EnvLike) []any {
	out := []any{}
	for _, e := range runtime.LLMProvidersFromEnv(env) {
		o := u.NewObj("id", e.ID)
		if e.APIKey != "" {
			o.Set("apiKey", e.APIKey)
		}
		if e.BaseURL != "" {
			o.Set("baseURL", e.BaseURL)
		}
		if e.Model != "" {
			o.Set("model", e.Model)
		}
		out = append(out, o)
	}
	return out
}

var idRe = regexp.MustCompile(`\b(p-[a-z0-9-]+?-|k-)([0-9a-f]{8})\b`)

// maskIds：与录制端相同——按首次出现顺序把生成的 id 换成 #N
func maskIds(s string) string {
	seen := map[string]string{}
	return idRe.ReplaceAllStringFunc(s, func(m string) string {
		sub := idRe.FindStringSubmatch(m)
		if _, ok := seen[sub[2]]; !ok {
			seen[sub[2]] = "#" + strconv.Itoa(len(seen))
		}
		return sub[1] + seen[sub[2]]
	})
}

func resolveRefs(v any, st *Store) any {
	switch x := v.(type) {
	case string:
		if x == "__undefined__" {
			return u.Undefined
		}
		if strings.HasPrefix(x, "$p") {
			parts := strings.SplitN(x[2:], ".k", 2)
			pi, _ := strconv.Atoi(parts[0])
			ps := st.Providers()
			if len(parts) == 1 {
				if pi < len(ps) {
					return ps[pi].Get("id")
				}
				return "missing-" + parts[0]
			}
			ki, _ := strconv.Atoi(parts[1])
			if pi < len(ps) {
				if ks := arr(ps[pi].Get("keys")); ki < len(ks) {
					return u.AsObj(ks[ki]).Get("id")
				}
			}
			return "missing-" + x
		}
		return x
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = resolveRefs(e, st)
		}
		return out
	case *u.Obj:
		out := u.NewObj()
		for _, k := range x.Keys() {
			out.Set(k, resolveRefs(x.Get(k), st))
		}
		return out
	}
	return v
}

func replay(t *testing.T, ro *u.Obj) []any {
	dir := t.TempDir()
	file := ""
	if ro.Get("file") == true {
		file = filepath.Join(dir, "ai-providers.json")
		if s, ok := ro.Get("initial").(string); ok {
			if err := os.WriteFile(file, []byte(s), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
	tick := 1_700_000_000_000.0
	now := func() float64 { tick += 1000; return tick }
	calls := []any{}
	st := NewStore(StoreOptions{FilePath: file, Cipher: PlaintextCipher, Now: now, UsageFlushMs: 60_000, OnCall: func(e any) { calls = append(calls, e) }})
	changes := 0
	st.OnChange(func() { changes++ })
	env := envOf(ro.Get("env"))
	svc := NewService(ServiceOptions{Store: st, EnvEntries: runtime.LLMProvidersFromEnv(env), OverrideID: runtime.ProviderOverrideFromEnv(env)})
	files := func() []any {
		ents, _ := os.ReadDir(dir)
		names := []string{}
		for _, e := range ents {
			names = append(names, e.Name())
		}
		sort.Strings(names)
		out := []any{}
		ts := regexp.MustCompile(`\d{13}`)
		for _, n := range names {
			b, _ := os.ReadFile(filepath.Join(dir, n))
			out = append(out, u.NewObj("name", ts.ReplaceAllLiteralString(n, "TS"), "text", string(b)))
		}
		return out
	}
	steps := []any{u.NewObj("op", "init", "files", files(), "state", svc.State())}
	for _, opv := range arr(ro.Get("ops")) {
		ops := arr(opv)
		op := ops[0].(string)
		args := arr(resolveRefs(ops[1:], st))
		a := func(i int) any {
			if i < len(args) {
				return args[i]
			}
			return u.Undefined
		}
		sa := func(i int) string { return jsString(a(i)) }
		before := changes
		var v any = u.Undefined
		var err error
		switch op {
		case "upsert":
			v, err = svc.Upsert(u.AsObj(a(0)))
		case "remove":
			err = svc.Remove(sa(0))
		case "setActive":
			v, err = svc.SetActive(a(0), a(1))
		case "setModels":
			v, err = svc.SetModels(sa(0), a(1))
		case "storeSetModels":
			v, err = st.SetModels(sa(0), u.AsObj(a(1)))
		case "setRoute":
			v, err = svc.SetRoute(a(0), a(1))
		case "addKey":
			v, err = svc.AddKey(sa(0), a(1), a(2))
		case "rotateKey":
			v, err = svc.RotateKey(sa(0), a(1), a(2))
		case "removeKey":
			v, err = svc.RemoveKey(sa(0), a(1))
		case "promoteKey":
			v, err = svc.PromoteKey(sa(0), a(1))
		case "resetUsage":
			err = svc.ResetUsage(a(0))
		case "markKey":
			st.MarkKey(sa(0), a(1), a(2))
		case "recordUsage":
			st.RecordUsage(sa(0), a(1), a(2) == true)
		case "recordCall":
			st.RecordCall(a(0))
		case "resolveKeys":
			var ks []string
			ks, err = st.ResolveKeys(sa(0))
			if err == nil {
				l := []any{}
				for _, k := range ks {
					l = append(l, k)
				}
				v = l
			}
		case "usage":
			v = st.Usage()
		case "routes":
			v = st.Routes()
		case "has":
			v = st.Has(sa(0))
		case "flush":
			err = st.Flush()
		case "state":
			v = svc.State()
		case "meta":
			v = svc.Meta()
		case "presets":
			ids := []any{}
			for _, p := range svc.Presets() {
				ids = append(ids, u.AsObj(p).Get("id"))
			}
			v = ids
		case "reload":
			v = NewStore(StoreOptions{FilePath: file, Cipher: PlaintextCipher, Now: now}).List()
		default:
			t.Fatalf("bad op %s", op)
		}
		step := u.NewObj("op", op, "args", args)
		if err != nil {
			step.Set("ok", false).Set("error", err.Error()).Set("v", nil)
		} else {
			if isUndef(v) {
				v = nil
			}
			step.Set("ok", true).Set("v", v)
		}
		step.Set("changed", float64(changes-before)).Set("files", files()).Set("state", svc.State())
		steps = append(steps, step)
	}
	steps = append(steps, u.NewObj("op", "calls", "v", calls))
	_ = st.Flush()
	out, err := u.ParseString(maskIds(u.Stringify(steps)))
	if err != nil {
		t.Fatal(err)
	}
	return arr(out)
}
