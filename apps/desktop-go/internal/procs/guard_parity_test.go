package procs

import (
	"context"
	"encoding/json"
	"os"
	"strconv"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 金样：scripts/parity/record-b7s-guard.mjs（Node implement(appContract) + createServerSession）。
// 路由层顺序 NOT_FOUND → kind 不符 BAD_REQUEST → guard（surfaces / dangerous+untrusted）逐帧对齐。
func TestGuardParity(t *testing.T) {
	b, err := os.ReadFile("testdata/b7s-guard.json")
	if err != nil {
		t.Fatal(err)
	}
	gv, err := u.Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	gold := gv.([]any)
	r := contract.NewRouter()
	Install(r)
	frames := make(chan contract.ServerFrame, 1)
	sessions := map[string]*contract.Session{}
	session := func(surface string, trusted bool) *contract.Session {
		k := surface + strconv.FormatBool(trusted)
		if s := sessions[k]; s != nil {
			return s
		}
		s := r.NewSession(context.Background(), contract.Caller{Surface: surface, ID: 1, Untrusted: !trusted},
			func(f contract.ServerFrame) { frames <- f })
		sessions[k] = s
		return s
	}
	codes := map[string]bool{"NOT_FOUND": true, "BAD_REQUEST": true, "FORBIDDEN": true}
	tally := map[string]int{}
	for i, x := range gold {
		g := x.(*u.Obj)
		req, _ := json.Marshal(map[string]any{"t": "req", "id": "r" + strconv.Itoa(i+1), "kind": g.Get("kind"), "name": g.Get("name")})
		session(g.Get("surface").(string), g.Get("trusted").(bool)).Handle(req)
		f := <-frames
		var res any = "pass"
		if f.T == "err" && codes[f.Error.Code] {
			wb, _ := json.Marshal(f.Error)
			res, _ = u.Parse(wb)
		}
		if gs, ws := u.Stringify(res), u.Stringify(g.Get("res")); gs != ws {
			t.Fatalf("case %d (%s %v %s %s): got %s want %s", i, g.Get("surface"), g.Get("trusted"), g.Get("name"), g.Get("kind"), gs, ws)
		}
		if res == "pass" {
			tally["pass"]++
		} else {
			tally[f.Error.Code]++
		}
	}
	t.Logf("guard parity: %d cases %v", len(gold), tally)
}
