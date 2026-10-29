package pendingevents

import (
	"context"
	"encoding/json"
	"os"
	"reflect"
	"strconv"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

type golden struct {
	TTLDefault float64  `json:"ttlDefault"`
	Nav        []string `json:"nav"`
	Cases      []struct {
		Name      string            `json:"name"`
		GroupsDef json.RawMessage   `json:"groupsDef"`
		TTLMs     *float64          `json:"ttlMs"`
		Ops       []json.RawMessage `json:"ops"`
		Out       []string          `json:"out"`
	} `json:"cases"`
}

func load(t *testing.T) golden {
	p, _ := paritytest.Golden(t, "b7s2-pending.json", "testdata/b7s2-pending.json")
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	var g golden
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	return g
}

func eventJSON(e *Event) string {
	if e == nil {
		return "null"
	}
	return util.Stringify(util.NewObj("event", e.Event, "payload", e.Payload))
}

// run 经 Router（Pending 钩子 + 会话订阅）回放一个场景
func run(t *testing.T, groupsDef json.RawMessage, ttl *float64, ops []json.RawMessage) []string {
	gv, err := util.Parse(groupsDef)
	if err != nil {
		t.Fatal(err)
	}
	var groups []Group
	go_ := util.AsObj(gv)
	for _, k := range go_.Keys() {
		g := Group{Name: k}
		for _, e := range go_.Get(k).([]any) {
			g.Events = append(g.Events, e.(string))
		}
		groups = append(groups, g)
	}
	now := float64(1_700_000_000_000)
	p := New(Options{Groups: groups, TTLMs: ttl, Now: func() float64 { return now }})
	r := contract.NewRouter()
	Register(r, p)
	frames := make(chan contract.ServerFrame, 16)
	s := r.NewSession(context.Background(), contract.Caller{Surface: "chat"}, func(f contract.ServerFrame) {
		if f.T != "event" {
			frames <- f
		}
	})
	defer s.Close()
	var out []string
	reqID := 0
	for _, raw := range ops {
		v, err := util.Parse(raw)
		if err != nil {
			t.Fatal(err)
		}
		op := v.([]any)
		switch op[0] {
		case "sub", "unsub":
			b, _ := json.Marshal(contract.ClientFrame{T: op[0].(string), Event: op[1].(string)})
			s.Handle(b)
		case "pub":
			r.Emit(op[1].(string), op[2])
		case "tick":
			now += op[1].(float64)
		case "take":
			out = append(out, eventJSON(p.Take(op[1].(string))))
		case "nav":
			// 每次用新的请求 id：上一个请求的 goroutine 在回帧之后才清掉 active[id]，负载下复用 id 会撞上
			// 「Duplicate request id」（不稳定的根因）
			reqID++
			b, _ := json.Marshal(contract.ClientFrame{T: "req", ID: strconv.Itoa(reqID), Kind: "call", Name: "nav.takePending", Input: json.RawMessage("{}")})
			s.Handle(b)
			f := <-frames
			if f.T != "res" {
				t.Fatalf("frame %+v", f)
			}
			out = append(out, util.Stringify(f.Output))
		}
	}
	return out
}

func TestPendingEventsGolden(t *testing.T) {
	g := load(t)
	if g.TTLDefault != TTLMs || !reflect.DeepEqual(g.Nav, ChatNavEvents) {
		t.Fatalf("constants: ttl %v nav %v", g.TTLDefault, g.Nav)
	}
	for _, c := range g.Cases {
		if got := run(t, c.GroupsDef, c.TTLMs, c.Ops); !reflect.DeepEqual(got, c.Out) && !(len(got) == 0 && len(c.Out) == 0) {
			t.Errorf("%s:\n got %v\nwant %v", c.Name, got, c.Out)
		}
	}
}
