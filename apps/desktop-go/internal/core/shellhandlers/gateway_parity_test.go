package shellhandlers

// GatewayService 写操作 / state / runtimeConfig / nomiRoute / 隐私 / learn / keyStatus / 本地模型登记 golden
// （scripts/parity/record-gwservice.mjs；NOMI_LIVE_GOLDENS 设置时用本平台现场录制）。

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/providers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/gwstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/local"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/server"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/upstream"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

type gwFakeCipher struct{}

func (gwFakeCipher) Kind() string { return "safeStorage" }
func (gwFakeCipher) Encrypt(p string) (string, error) {
	return base64.StdEncoding.EncodeToString([]byte("ss:" + p)), nil
}
func (gwFakeCipher) Decrypt(s string) (string, error) {
	t := providers.NodeBase64Decode(s)
	if !strings.HasPrefix(t, "ss:") {
		return "", errors.New("bad")
	}
	return t[3:], nil
}

type gwGolden struct {
	Scenarios []struct {
		Name  string            `json:"name"`
		Steps []json.RawMessage `json:"steps"`
		Files map[string]string `json:"files"`
	} `json:"scenarios"`
}

type gwStep struct {
	Op   string            `json:"op"`
	Args []json.RawMessage `json:"args"`
}

var gwClock float64

func gwFixRandom(t *testing.T) {
	oldNow, oldUUID, oldRB := gwstore.Now, gwstore.RandomUUID, gwstore.RandomBytes
	t.Cleanup(func() { gwstore.Now, gwstore.RandomUUID, gwstore.RandomBytes = oldNow, oldUUID, oldRB })
	gwClock = 1793500000000
	n, rb := 0, 0
	gwstore.Now = func() float64 { return gwClock }
	gwstore.RandomUUID = func() string { n++; return fmt.Sprintf("%08x-0000-4000-8000-000000000000", n) }
	gwstore.RandomBytes = func(k int) []byte {
		rb++
		b := make([]byte, k)
		for i := range b {
			b[i] = byte(rb)
		}
		return b
	}
}

func loadGwGolden(t *testing.T) gwGolden {
	p := filepath.Join("..", "gwstore", "testdata", "gwservice.json")
	if d := os.Getenv("NOMI_LIVE_GOLDENS"); d != "" {
		p = filepath.Join(d, "gwservice.json")
	}
	raw, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	var g gwGolden
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	return g
}

func jsObj(raw json.RawMessage) any {
	v, _ := u.Parse(raw)
	return v
}

func jsStr(raw json.RawMessage) string {
	var s string
	_ = json.Unmarshal(raw, &s)
	return s
}

func newGwService(t *testing.T, ud string) *gwstore.Service {
	port := 18999
	s := gwstore.NewService(filepath.Join(ud, "gateway"), gwFakeCipher{}, nil, nil)
	s.AttachRuntime(gwstore.RuntimeDeps{
		Root: filepath.Join(ud, "gateway"), Port: &port, Lazy: true, Env: map[string]string{},
		EnvProviders: func() []gwstore.EnvProvider {
			return []gwstore.EnvProvider{{ID: "deepseek", Name: "DeepSeek (env)", Wire: "chat", URL: "https://api.deepseek.com/v1", Key: "sk-env-deepseek-123456", KeyEnv: "DEEPSEEK_API_KEY", Model: "deepseek-chat"}}
		},
	})
	if err := s.Init(); err != nil {
		t.Fatal(err)
	}
	s.Start()
	return s
}

// localRegister：LocalModelService.registerInGateway 对 GatewayLike 的调用顺序（local/service.go）
func localRegister(gw local.GatewayLike, model, baseURL, gpid string) (string, error) {
	pu, _ := url.Parse(baseURL)
	p := pu.Port()
	if p == "" {
		p = "80"
	}
	if err := gw.ConfirmPrivateHost(pu.Hostname() + ":" + p); err != nil {
		return "", err
	}
	in := local.GatewayUpsert{Name: "Local model", PresetID: local.LocalPresetID, URLs: map[string]string{"chat": baseURL}, Models: []local.GatewayModel{{ID: model, Enabled: true}}}
	for _, pv := range gw.Providers() {
		if (gpid != "" && pv.ID == gpid) || pv.PresetID == local.LocalPresetID {
			in.ID = pv.ID
			break
		}
	}
	return gw.UpsertProvider(in)
}

func runGwOp(s *gwstore.Service, gw local.GatewayLike, op string, a []json.RawMessage) (any, error) {
	arg := func(i int) json.RawMessage {
		if i < len(a) {
			return a[i]
		}
		return json.RawMessage("null")
	}
	obj := func(i int) *u.Obj { o, _ := jsObj(arg(i)).(*u.Obj); return o }
	switch op {
	case "upsertProvider":
		return s.UpsertProvider(obj(0))
	case "removeProvider":
		return nil, s.RemoveProvider(jsStr(arg(0)))
	case "setAssignment":
		return nil, s.SetAssignmentFor(jsStr(arg(0)), obj(1))
	case "resetToken":
		return nil, s.ResetTokenFor(jsStr(arg(0)))
	case "setOptions":
		return s.SetOptions(obj(0))
	case "confirmPrivateHost":
		return nil, s.ConfirmPrivateHost(jsStr(arg(0)))
	case "clearLearned":
		return nil, s.ClearLearned(jsStr(arg(0)))
	case "setPrivacyAction":
		return s.SetPrivacyAction(jsObj(arg(0)), jsObj(arg(1)))
	case "addPrivacySecret":
		return s.AddPrivacySecret(jsObj(arg(0)))
	case "removePrivacySecret":
		return s.RemovePrivacySecret(jsObj(arg(0)))
	case "addPrivacyAllow":
		return s.AddPrivacyAllow(jsObj(arg(0)))
	case "removePrivacyAllow":
		return s.RemovePrivacyAllow(jsObj(arg(0)))
	case "previewPrivacy":
		return s.PreviewPrivacy(jsObj(arg(0))), nil
	case "learn":
		var e struct {
			Type, ProviderID, Model, Exclude, Wire, Param, Reason, CatalogVersion string
			Efforts                                                               []string
			At                                                                    *float64
		}
		_ = json.Unmarshal(arg(0), &e)
		at := math.NaN() // 事件没带 at（Node: Number.isFinite(undefined) = false）
		if e.At != nil {
			at = *e.At
		}
		s.Learn(server.LearnEvent{Type: e.Type, ProviderID: e.ProviderID, Model: e.Model, Exclude: e.Exclude, Wire: e.Wire, Param: e.Param, Reason: e.Reason, CatalogVersion: e.CatalogVersion, Efforts: e.Efforts, At: at})
		return nil, nil
	case "keyStatus":
		var e upstream.KeyStatusEvent
		var r struct {
			ProviderID, KeyID, Wire, Status string
			Error                           *string
			Until                           *float64
		}
		_ = json.Unmarshal(arg(0), &r)
		e = upstream.KeyStatusEvent{ProviderID: r.ProviderID, KeyID: r.KeyID, Wire: r.Wire, Status: r.Status, Error: r.Error, Until: r.Until}
		s.KeyStatus(e)
		return nil, nil
	case "local.register":
		return localRegister(gw, jsStr(arg(0)), jsStr(arg(1)), jsStr(arg(2)))
	case "local.useAsChat":
		return nil, gw.SetNomiMain(jsStr(arg(0)))
	}
	return nil, fmt.Errorf("unknown op %s", op)
}

func nomiRouteObj(r *gwstore.NomiRoute) any {
	if r == nil {
		return nil
	}
	return u.NewObj("baseURL", r.BaseURL, "token", r.Token, "model", r.Model, "protocol", r.Protocol,
		"receiver", u.NewObj("id", r.ReceiverID, "baseURL", r.ReceiverBaseURL))
}

func canon(v any) string {
	p, _ := u.ParseString(u.Stringify(v))
	return u.Stringify(p)
}

func TestGatewayServiceParity(t *testing.T) {
	g := loadGwGolden(t)
	if len(g.Scenarios) != 5 {
		t.Fatalf("scenarios=%d", len(g.Scenarios))
	}
	for _, sc := range g.Scenarios {
		t.Run(sc.Name, func(t *testing.T) {
			gwFixRandom(t)
			ud := t.TempDir()
			s := newGwService(t, ud)
			gw := LocalGateway(s)()
			for i, raw := range sc.Steps {
				var st gwStep
				if err := json.Unmarshal(raw, &st); err != nil {
					t.Fatal(err)
				}
				want, _ := jsObj(raw).(*u.Obj)
				gwClock += 1000
				res, err := runGwOp(s, gw, st.Op, st.Args)
				got := u.NewObj("op", want.Get("op"), "args", want.Get("args"))
				if err != nil {
					got.Set("error", err.Error())
				} else {
					if o, ok := res.(*u.Obj); ok && o == nil {
						res = nil
					}
					got.Set("result", res)
				}
				state := s.State()
				state.Delete("status")
				if res, ok := got.Get("result").(*u.Obj); ok && res != nil && res.Has("status") && res.Has("catalog") {
					res.Set("status", u.NewObj("state", "stopped"))
				}
				got.Set("state", state).Set("runtimeConfig", s.RuntimeConfig()).
					Set("nomiMain", nomiRouteObj(s.NomiRoute("main"))).Set("nomiTools", nomiRouteObj(s.NomiRoute("tools")))
				gs := strings.ReplaceAll(strings.ReplaceAll(canon(got), strings.ReplaceAll(ud, `\`, `\\`), "<UD>"), ud, "<UD>")
				if runtime.GOOS == "windows" {
					gs = strings.ReplaceAll(gs, `<UD>\\gateway\\`, "<UD>/gateway/")
				}
				ws := canon(want)
				if gs != ws {
					t.Fatalf("step %d %s %s\n--- node\n%s\n--- go\n%s", i, st.Op, string(raw[:0]), ws, gs)
				}
			}
			s.Dispose()
			time.Sleep(50 * time.Millisecond)
			gotFiles := map[string]string{}
			_ = filepath.Walk(ud, func(p string, info os.FileInfo, err error) error {
				if err != nil || info.IsDir() {
					return err
				}
				rel, _ := filepath.Rel(ud, p)
				b, _ := os.ReadFile(p)
				gotFiles[filepath.ToSlash(rel)] = strings.ReplaceAll(string(b), ud, "<UD>")
				return nil
			})
			keys := []string{}
			for k := range sc.Files {
				keys = append(keys, k)
			}
			for k := range gotFiles {
				if _, ok := sc.Files[k]; !ok {
					keys = append(keys, k)
				}
			}
			sort.Strings(keys)
			for _, k := range keys {
				if sc.Files[k] != gotFiles[k] {
					t.Errorf("file %s differs\n--- node\n%s\n--- go\n%s", k, sc.Files[k], gotFiles[k])
				}
			}
		})
	}
}
