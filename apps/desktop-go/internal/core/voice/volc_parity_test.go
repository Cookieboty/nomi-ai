package voice

import (
	"encoding/hex"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

// D-B9-1 / D-B9-5：与 Node VolcAsrSession 对同一模拟服务脚本：握手头（顺序 / 值）、客户端帧（头 + 解压负载）、临时 / 最终结果、LogID
func TestParityB9Volc(t *testing.T) {
	var g struct {
		Volc struct {
			URL        string
			RawHeaders []string
			Frames     []struct{ Head, Payload string }
			Script     []struct{ On, Frame string }
			Partials   []string
			Text       string
			LogID      *string
			PCM        string
		}
	}
	raw, err := os.ReadFile(volcGoldenPath())
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	v := g.Volc
	if len(v.Frames) == 0 {
		t.Fatal("golden has no volc")
	}
	send := func(c net.Conn, on string) {
		for _, s := range v.Script {
			if s.On == on {
				b, _ := hex.DecodeString(s.Frame)
				c.Write(srvFrame(2, b))
			}
		}
	}
	m := newMockVolc(t)
	m.logID = "LOG-B9"
	sentAudio := false
	m.onFrame = func(c net.Conn, n int, p []byte) {
		switch {
		case p[1]>>4 == msgFullClient:
			send(c, "full")
		case p[1]&flagLast != 0:
			send(c, "last")
		case !sentAudio:
			sentAudio = true
			send(c, "audio")
		}
	}
	var parts []string
	var pmu sync.Mutex
	s := NewVolcSession(VolcOpts{APIKey: "k-secret", ResourceID: "volc.seedasr.sauc.duration", URL: m.url(), Retries: zero(),
		OnPartial: func(x string) { pmu.Lock(); parts = append(parts, x); pmu.Unlock() }})
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	pcm, _ := hex.DecodeString(v.PCM)
	s.Push(pcm[:7000])
	time.Sleep(150 * time.Millisecond)
	s.Push(pcm[7000:])
	text, err := s.Finish()
	if err != nil || text != v.Text {
		t.Fatalf("text go=%q node=%q err=%v", text, v.Text, err)
	}
	pmu.Lock()
	if !reflect.DeepEqual(parts, v.Partials) {
		t.Errorf("partials go=%q node=%q", parts, v.Partials)
	}
	pmu.Unlock()
	if id, ok := s.ServerLogID(); v.LogID == nil || !ok || id != *v.LogID {
		t.Errorf("logid go=%q", id)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	uuidRe := regexp.MustCompile(`^[0-9a-f-]{36}$`)
	var rh []string
	for _, l := range m.reqs[0][1:] {
		k, val, _ := strings.Cut(l, ": ")
		switch strings.ToLower(k) {
		case "sec-websocket-key":
			val = "KEY"
		case "host":
			val = "HOST"
		case "x-api-connect-id":
			if uuidRe.MatchString(val) {
				val = "UUID"
			}
		}
		if val == s.RequestID {
			val = "REQUEST_ID"
		}
		rh = append(rh, k, val)
	}
	if !reflect.DeepEqual(rh, v.RawHeaders) {
		t.Errorf("rawHeaders\n go=%q\nnode=%q", rh, v.RawHeaders)
	}
	if want := "GET " + v.URL + " HTTP/1.1"; m.reqs[0][0] != want {
		t.Errorf("request line %q want %q", m.reqs[0][0], want)
	}
	if len(m.frames) != len(v.Frames) {
		t.Fatalf("frames go=%d node=%d", len(m.frames), len(v.Frames))
	}
	for i, f := range m.frames {
		pl, err := gunzipSync(f[8:])
		if err != nil {
			t.Fatal(err)
		}
		got := hex.EncodeToString(pl)
		if f[1]>>4 == msgFullClient {
			got = string(pl)
		}
		if hex.EncodeToString(f[:4]) != v.Frames[i].Head || got != v.Frames[i].Payload {
			t.Errorf("frame %d head go=%x node=%s payload equal=%v", i, f[:4], v.Frames[i].Head, got == v.Frames[i].Payload)
		}
	}
}

func volcGoldenPath() string {
	if d := os.Getenv("NOMI_LIVE_GOLDENS"); d != "" {
		if _, err := os.Stat(filepath.Join(d, "parity-b9.json")); err == nil {
			return filepath.Join(d, "parity-b9.json")
		}
	}
	return filepath.Join("testdata", "parity-b9.json")
}
