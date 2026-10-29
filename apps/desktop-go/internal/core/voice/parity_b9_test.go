package voice_test

// 批次 9 golden parity：回放 scripts/parity/record-b9.mjs 录下的 Node 输出（逐字段、键序一致）。
// NOMI_LIVE_GOLDENS 指向 CI 当前平台现场录制目录时优先用它。

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/tts"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/tts/edge"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/voice"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/types"
)

type kase struct {
	In  json.RawMessage `json:"in"`
	Out json.RawMessage `json:"out"`
}

type golden struct {
	Edge struct {
		Gec, SynthURL, VoicesURL, Rate, Escape, Ssml, DateString, TextPath []kase
		SocketHeaders, HTTPHeaders                                         [][2]string
		ConfigFrame                                                        string
	}
	EdgeClient []struct {
		Name  string
		Voice string
		Steps []map[string]any
		Out   json.RawMessage
	}
	TTS struct {
		Normalize, Validate, Reply, EnvOverride []kase
	}
	Voice struct {
		Defaults                                       json.RawMessage
		Sanitize, CloudTarget, Args, Clean, Wav, TURLs []kase
		TranscriptionsURL                              []kase
		CliNames                                       []string
	}
	Speech []kase
	Speak  []struct {
		In struct {
			Text  string
			Voice *string
			Rate  *string
		}
		Out json.RawMessage
	}
	Cloud []struct {
		Resp struct {
			Status int
			Body   string
		}
		Req  map[string]string
		Out  json.RawMessage
		Seen json.RawMessage
	}
}

var parityChecks int

func goldenPath() string {
	p := filepath.Join("testdata", "parity-b9.json")
	if d := os.Getenv("NOMI_LIVE_GOLDENS"); d != "" {
		if _, err := os.Stat(filepath.Join(d, "parity-b9.json")); err == nil {
			p = filepath.Join(d, "parity-b9.json")
		}
	}
	return p
}

func load(t *testing.T) golden {
	b, err := os.ReadFile(goldenPath())
	if err != nil {
		t.Fatal(err)
	}
	var g golden
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	return g
}

func canon(t *testing.T, v any) string {
	t.Helper()
	var b []byte
	switch x := v.(type) {
	case json.RawMessage:
		b = x
	case string:
		b, _ = json.Marshal(x)
	default:
		var err error
		if b, err = json.Marshal(v); err != nil {
			t.Fatal(err)
		}
	}
	p, err := util.Parse(b)
	if err != nil {
		t.Fatalf("parse %s: %v", b, err)
	}
	return util.Stringify(p)
}

func eq(t *testing.T, name string, want json.RawMessage, got any) {
	t.Helper()
	parityChecks++
	if w, g := canon(t, want), canon(t, got); w != g {
		t.Errorf("%s:\n want %s\n  got %s", name, w, g)
	}
}

func parsed(t *testing.T, b json.RawMessage) any {
	v, err := util.Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

var (
	tsRe  = regexp.MustCompile(`X-Timestamp:[^\r\n]*`)
	ridRe = regexp.MustCompile(`X-RequestId:[0-9a-f]+`)
	cidRe = regexp.MustCompile(`ConnectionId=[0-9a-f]+`)
)

func norm(s string) string {
	return ridRe.ReplaceAllString(tsRe.ReplaceAllString(s, "X-Timestamp:<T>"), "X-RequestId:<ID>")
}

func num(t *testing.T, b json.RawMessage) float64 {
	var s string
	if json.Unmarshal(b, &s) == nil {
		f, err := strconv.ParseFloat(s, 64)
		if err != nil {
			t.Fatal(err)
		}
		return f
	}
	var f float64
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

func TestParityB9Edge(t *testing.T) {
	g := load(t).Edge
	for _, c := range g.Gec {
		eq(t, "secMsGec", c.Out, edge.SecMsGec(num(t, c.In)))
	}
	for _, c := range g.SynthURL {
		var w string
		_ = json.Unmarshal(c.Out, &w)
		parityChecks++
		if a, b := cidRe.ReplaceAllString(w, "ConnectionId=<C>"), cidRe.ReplaceAllString(edge.SynthesisURL(num(t, c.In)), "ConnectionId=<C>"); a != b {
			t.Errorf("synthUrl: want %s got %s", a, b)
		}
	}
	for _, c := range g.VoicesURL {
		eq(t, "voicesUrl", c.Out, edge.VoicesURL(num(t, c.In)))
	}
	hdr := func(h edge.Header) [][2]string {
		var out [][2]string
		for _, kv := range h {
			if kv[0] == "Cookie" {
				kv[1] = "<MUID>"
			}
			out = append(out, [2]string{kv[0], kv[1]})
		}
		return out
	}
	wantSH, _ := json.Marshal(g.SocketHeaders)
	eq(t, "socketHeaders", wantSH, hdr(edge.SocketHeaders()))
	wantHH, _ := json.Marshal(g.HTTPHeaders)
	eq(t, "httpHeaders", wantHH, hdr(edge.HTTPHeaders()))
	wantCF, _ := json.Marshal(g.ConfigFrame)
	eq(t, "configFrame", wantCF, norm(edge.ConfigFrame()))
	for _, c := range g.Rate {
		eq(t, "formatRate "+string(c.In), c.Out, edge.FormatRate(num(t, c.In)))
	}
	for _, c := range g.Escape {
		var s string
		_ = json.Unmarshal(c.In, &s)
		eq(t, "escapeXml", c.Out, edge.EscapeXML(s))
	}
	for _, c := range g.Ssml {
		var in []any
		_ = json.Unmarshal(c.In, &in)
		eq(t, "ssml", c.Out, norm(edge.SSMLFrame(in[0].(string), in[1].(string), in[2].(float64))))
	}
	t.Setenv("TZ", "UTC")
	old := time.Local
	time.Local = time.UTC
	defer func() { time.Local = old }()
	for _, c := range g.DateString {
		ms := int64(num(t, c.In))
		eq(t, "dateString", c.Out, edge.JSDateString(time.UnixMilli(ms)))
	}
	for _, c := range g.TextPath {
		var s string
		_ = json.Unmarshal(c.In, &s)
		var got any
		if p, ok := edge.TextFramePath(s); ok {
			got = p
		}
		eq(t, "textFramePath "+s, c.Out, got)
	}
}

type fakeSock struct {
	steps []map[string]any
	i     int
	sent  []string
}

func (f *fakeSock) Read(ctx context.Context) ([]byte, bool, error) {
	for f.i < len(f.steps) {
		s := f.steps[f.i]
		f.i++
		if b, ok := s["bin"].(string); ok {
			d, _ := base64.StdEncoding.DecodeString(b)
			return d, true, nil
		}
		if x, ok := s["text"].(string); ok {
			return []byte(x), false, nil
		}
		if _, ok := s["close"]; ok {
			return nil, false, io.EOF
		}
	}
	<-ctx.Done()
	return nil, false, ctx.Err()
}
func (f *fakeSock) Send(_ context.Context, s string) error {
	f.sent = append(f.sent, norm(s))
	return nil
}
func (f *fakeSock) Terminate() {}

func TestParityB9EdgeClient(t *testing.T) {
	for _, c := range load(t).EdgeClient {
		var fs *fakeSock
		factory := func(_ context.Context, _ string, _ edge.Header) (edge.Socket, error) {
			if len(c.Steps) > 0 {
				s := c.Steps[0]
				if st, ok := s["status"].(float64); ok {
					return nil, &edge.DialError{Status: int(st)}
				}
				if msg, ok := s["error"].(string); ok {
					code, _ := s["code"].(string)
					return nil, &edge.DialError{Code: code, Msg: msg}
				}
			}
			fs = &fakeSock{steps: c.Steps}
			return fs, nil
		}
		voiceName := c.Voice
		if voiceName == "" {
			voiceName = "zh-CN-XiaoxiaoNeural"
		}
		buf, err := edge.NewClient(factory).Synthesize(context.Background(), "你好", edge.SynthOptions{Voice: voiceName, Rate: 10, Timeout: 2 * time.Second})
		out := util.NewObj()
		if err != nil {
			var te *edge.TtsError
			if !errors.As(err, &te) {
				t.Fatalf("%s: %v", c.Name, err)
			}
			out.Set("kind", string(te.Kind)).Set("message", te.Msg)
		} else {
			out.Set("ok", base64.StdEncoding.EncodeToString(buf))
		}
		sent := []string{}
		if fs != nil {
			sent = fs.sent
		}
		out.Set("sent", sent)
		eq(t, "edgeClient "+c.Name, c.Out, out)
	}
}

func TestParityB9TTS(t *testing.T) {
	g := load(t).TTS
	for _, c := range g.Normalize {
		eq(t, "normalize "+string(c.In), c.Out, tts.Normalize(parsed(t, c.In)))
	}
	for _, c := range g.Validate {
		ok, errs := tts.Validate(parsed(t, c.In))
		if errs == nil {
			errs = []string{}
		}
		eq(t, "validate "+string(c.In), c.Out, util.NewObj("isValid", ok, "errors", errs))
	}
	for _, c := range g.Reply {
		var in []json.RawMessage
		_ = json.Unmarshal(c.In, &in)
		var cfg *tts.Config
		if string(in[1]) != "null" {
			n := tts.Normalize(parsed(t, in[1]))
			cfg = &n
		}
		var env map[string]string
		_ = json.Unmarshal(in[2], &env)
		var got any
		if r := tts.ReplySpeechCommand(parsed(t, in[0]), cfg, env); r != nil {
			got = r
		}
		eq(t, "reply "+string(c.In), c.Out, got)
	}
	for _, c := range g.EnvOverride {
		var in []json.RawMessage
		_ = json.Unmarshal(c.In, &in)
		var en bool
		var env map[string]string
		_ = json.Unmarshal(in[0], &en)
		_ = json.Unmarshal(in[1], &env)
		r := tts.ApplyEnvOverride(tts.RouteConfig{Enabled: en}, env)
		eq(t, "envOverride", c.Out, util.NewObj("enabled", r.Enabled))
	}
}

func TestParityB9Voice(t *testing.T) {
	g := load(t).Voice
	eq(t, "defaults", g.Defaults, voice.DefaultSettings())
	for _, c := range g.Sanitize {
		eq(t, "sanitize "+string(c.In), c.Out, voice.Sanitize(parsed(t, c.In), voice.DefaultSettings()))
	}
	for _, c := range g.CloudTarget {
		eq(t, "cloudTarget "+string(c.In), c.Out, voice.CloudTargetID(voice.Sanitize(parsed(t, c.In), voice.DefaultSettings())))
	}
	parityChecks++
	if fmt.Sprint(g.CliNames) != fmt.Sprint(voice.CliNames()) {
		t.Errorf("cliNames: want %v got %v", g.CliNames, voice.CliNames())
	}
	for _, c := range g.Args {
		var o struct {
			Model, Wav, Language, Prompt string
			Threads                      int
		}
		_ = json.Unmarshal(c.In, &o)
		eq(t, "buildArgs", c.Out, voice.BuildArgs(o.Model, o.Wav, o.Language, o.Prompt, o.Threads))
	}
	for _, c := range g.Clean {
		var s string
		_ = json.Unmarshal(c.In, &s)
		eq(t, "clean "+s, c.Out, voice.CleanTranscript(s))
	}
	for _, c := range g.Wav {
		var in []byte
		var ints []int
		_ = json.Unmarshal(c.In, &ints)
		for _, i := range ints {
			in = append(in, byte(i))
		}
		eq(t, "pcmToWav", c.Out, base64.StdEncoding.EncodeToString(voice.PcmToWav(in)))
	}
	for _, c := range g.TranscriptionsURL {
		var s string
		_ = json.Unmarshal(c.In, &s)
		eq(t, "transcriptionsURL", c.Out, voice.TranscriptionsURL(s))
	}
}

var fieldRe = regexp.MustCompile(`name="([^"]+)"(?:; filename="([^"]+)")?\r\n(?:Content-Type: ([^\r\n]+)\r\n)?\r\n([^\r]*)`)

func TestParityB9CloudASR(t *testing.T) {
	for _, c := range load(t).Cloud {
		var seen *util.Obj
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			body, _ := io.ReadAll(r.Body)
			fields := [][]any{}
			for _, m := range fieldRe.FindAllSubmatch(body, -1) {
				f := []any{string(m[1]), nil, nil, nil}
				if len(m[2]) > 0 {
					f[1] = string(m[2])
				} else {
					f[3] = string(m[4])
				}
				if len(m[3]) > 0 {
					f[2] = string(m[3])
				}
				fields = append(fields, f)
			}
			var auth any
			if a := r.Header.Get("Authorization"); a != "" {
				auth = a
			}
			ct := r.Header.Get("Content-Type")
			boundary := ""
			if m := regexp.MustCompile(`boundary=(.*)$`).FindStringSubmatch(ct); m != nil {
				boundary = m[1]
			}
			norm := func(v string) string {
				if boundary == "" {
					return v
				}
				return strings.ReplaceAll(v, boundary, "BOUNDARY")
			}
			headers := [][]any{{"host", "HOST"}}
			for k, vs := range r.Header {
				lk := strings.ToLower(k)
				if lk == "connection" {
					continue
				}
				for _, v := range vs {
					headers = append(headers, []any{lk, norm(v)})
				}
			}
			sort.SliceStable(headers, func(i, j int) bool { return headers[i][0].(string) < headers[j][0].(string) })
			lat := make([]rune, len(body))
			for i, c := range body {
				lat[i] = rune(c)
			}
			seen = util.NewObj("method", r.Method, "url", r.URL.RequestURI(), "auth", auth,
				"multipart", regexp.MustCompile(`^multipart/form-data; boundary=`).MatchString(ct), "fields", fields,
				"boundary", regexp.MustCompile(`^----formdata-undici-0\d{11}$`).MatchString(boundary), "headers", headers, "body", norm(string(lat)))
			w.Header().Set("content-type", "text/plain")
			w.WriteHeader(c.Resp.Status)
			_, _ = w.Write([]byte(c.Resp.Body))
		}))
		text, err := voice.TranscribeOpenAICompat(context.Background(), voice.CloudOpts{
			BaseURL: srv.URL + "/v1/", APIKey: c.Req["apiKey"], Model: c.Req["model"], Wav: []byte{1, 2, 3},
			Language: c.Req["language"], Prompt: c.Req["prompt"], T: i18n.T,
		})
		srv.Close()
		out := util.NewObj()
		if err != nil {
			out.Set("error", err.Error())
		} else {
			out.Set("text", text)
		}
		name := fmt.Sprintf("cloud %d %v", c.Resp.Status, c.Req)
		eq(t, name+" out", c.Out, out)
		eq(t, name+" seen", c.Seen, seen)
	}
}

type fakeSynth struct{ calls []*util.Obj }

func (f *fakeSynth) Synthesize(_ context.Context, text string, o edge.SynthOptions) ([]byte, error) {
	f.calls = append(f.calls, util.NewObj("text", text, "voice", o.Voice, "rate", o.Rate))
	return []byte("mp3"), nil
}

func TestParityB9Speech(t *testing.T) {
	g := load(t)
	for _, c := range g.Speech {
		var s string
		_ = json.Unmarshal(c.In, &s)
		eq(t, "cleanTextForSpeech "+s, c.Out, types.CleanTextForSpeech(s))
	}
	for _, c := range g.Speak {
		f := &fakeSynth{}
		svc := edge.NewService(f, func() time.Time { return time.UnixMilli(42) })
		p := edge.SpeakParams{Text: c.In.Text}
		if c.In.Voice != nil {
			p.Voice = *c.In.Voice
		}
		if c.In.Rate != nil {
			r, _ := strconv.ParseFloat(*c.In.Rate, 64)
			p.Rate = &r
		}
		r := svc.Speak(p)
		var kind, msg any
		if !r.OK {
			kind, msg = r.Kind, r.Message
		}
		calls := f.calls
		if calls == nil {
			calls = []*util.Obj{}
		}
		eq(t, "speak "+c.In.Text, c.Out, util.NewObj("ok", r.OK, "kind", kind, "message", msg, "calls", calls))
	}
}

func TestParityB9Count(t *testing.T) { t.Logf("parity checks so far: %d", parityChecks) }

func TestParityB9Exec(t *testing.T) {
	var g struct {
		Exec []struct {
			Name    string
			File    string
			Args    []string
			Timeout int
			Abort   int
			Out     *string
		}
	}
	raw, err := os.ReadFile(goldenPath())
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	if len(g.Exec) == 0 {
		t.Skip("no exec golden (recorded on win32)")
	}
	for _, c := range g.Exec {
		got := voice.RunExecForTest(c.File, c.Args, time.Duration(c.Timeout)*time.Millisecond, time.Duration(c.Abort)*time.Millisecond)
		if c.Out == nil || got != *c.Out {
			t.Errorf("exec %s: got %q want %v", c.Name, got, c.Out)
		}
		parityChecks++
	}
}
