package knowledgehandlers

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/connections"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/tasks"
)

type plainBox struct{}

func (plainBox) CanEncrypt() bool                    { return true }
func (plainBox) Encrypt(v, _ string) (string, error) { return "enc:" + v, nil }
func (plainBox) Decrypt(v string) string             { return v[len("enc:"):] }

// gh 换账号后改用当前账号：引用这条连接的任务授权被撤销，其余任务不动；重复添加报 CONNECTIONS_DUPLICATE
func TestConnectionsRebindRevokesTasks(t *testing.T) {
	login := "octo"
	conns := connections.New(connections.Deps{File: filepath.Join(t.TempDir(), "connections.json"), Secrets: plainBox{},
		RunGh: func(_ context.Context, args []string) ([]byte, int) {
			if args[0] == "auth" {
				return []byte(fmt.Sprintf(`{"hosts":{"github.com":[{"active":true,"host":"github.com","login":%q,"scopes":"repo","state":"success"}]}}`, login)), 0
			}
			return []byte(`{}`), 0
		}})
	svc := tasks.NewService(tasks.ServiceDeps{Root: t.TempDir(), Log: nopLog{}, Notify: func(string, string) {}})
	svc.Start()
	defer svc.Stop()
	sv := Services{Tasks: func() *tasks.Service { return svc }, Conns: func() *connections.Service { return conns }}
	ch, th := connectionHandlers(sv), taskHandlers(sv)
	call := func(hs map[string]H, name, in string) any {
		v, err := hs[name](context.Background(), json.RawMessage(in))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		return v
	}
	c := call(ch, "connections.addGithub", `{"mode":"gh"}`).(*connections.Connection)
	if _, err := ch["connections.addGithub"](context.Background(), json.RawMessage(`{"mode":"gh"}`)); err == nil ||
		err.(*contract.Error).Code != "CONNECTIONS_DUPLICATE" {
		t.Fatal(err)
	}
	mk := func(connID string) string {
		conn := `[]`
		if connID != "" {
			conn = `[{"connectionId":"` + connID + `","capabilities":["github.read"],"resources":["o/r"]}]`
		}
		return call(th, "tasks.create", `{"title":"t","goal":"g","trigger":{"kind":"manual"},
			"executor":{"kind":"notify","text":"hi"},"grant":{"level":1,"paths":[],"connections":`+conn+`}}`).(tasks.Task).ID
	}
	using, other := mk(c.ID), mk("")
	login = "mona"
	r := call(ch, "connections.rebind", `{"id":"`+c.ID+`"}`).(*connections.Connection)
	if r.ID != c.ID || r.Account.Login != "mona" || r.Status != "ok" {
		t.Fatalf("%+v", r)
	}
	if g := svc.Get(using).Task.Grant; g.RevokedAt == nil {
		t.Fatalf("not revoked: %+v", g)
	}
	if g := svc.Get(other).Task.Grant; g.RevokedAt != nil {
		t.Fatalf("revoked: %+v", g)
	}
}
