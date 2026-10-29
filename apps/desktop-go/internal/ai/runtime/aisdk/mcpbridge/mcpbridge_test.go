package mcpbridge

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/mcp"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

type fakeClient struct {
	tools   string
	listErr error
	closed  int
	calls   []string
	result  string
}

func (f *fakeClient) ListTools(*u.Obj, *mcp.RequestOptions) (*u.Obj, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	v, _ := u.ParseString(f.tools)
	return v.(*u.Obj), nil
}
func (f *fakeClient) CallTool(name string, args *u.Obj, _ *mcp.RequestOptions) (*u.Obj, error) {
	b := u.Stringify(args)
	f.calls = append(f.calls, name+" "+b)
	v, _ := u.ParseString(f.result)
	return v.(*u.Obj), nil
}
func (f *fakeClient) Close() error { f.closed++; return nil }

func mustParse(s string) *u.Obj { v, _ := u.ParseString(s); return v.(*u.Obj) }

func TestConnectRegistersAndDisconnectUnregisters(t *testing.T) {
	reg := tools.NewInMemory()
	fc := &fakeClient{tools: `{"tools":[{"name":"read_file","inputSchema":{"properties":{}},"annotations":{"readOnlyHint":true}},{"name":"exec","title":"Exec","inputSchema":{"type":"object"}},{"name":"plain","description":"d","inputSchema":{"type":"object"}}]}`,
		result: `{"content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}`}
	var gotCfg mcp.ClientConfig
	s := New(Options{GetRegistry: func() tools.Registry { return reg }, CreateClient: func(c mcp.ClientConfig) (Client, error) { gotCfg = c; return fc, nil }})
	var ev []string
	s.On(EventServerUp, func(i ServerInfo) { ev = append(ev, "up:"+i.ID+":"+i.URL) })
	s.On(EventServerDown, func(i ServerInfo) { ev = append(ev, "down:"+i.ID) })
	if err := s.Connect(ServerConfig{ID: "srv", Name: "S", Transport: "http", URL: " http://x/mcp "}); err != nil {
		t.Fatal(err)
	}
	if gotCfg.TransportConfig.URL != "http://x/mcp" || *gotCfg.InitializationOptions.Timeout != 30000 {
		t.Fatalf("cfg %+v", gotCfg)
	}
	d, ok := reg.Get("srv__read_file")
	if !ok || d.Dangerous || !d.ReadOnly || d.Description != "srv__read_file" {
		t.Fatalf("read_file %+v", d)
	}
	if b := u.Stringify(d.Input); b != `{"properties":{},"type":"object"}` {
		t.Fatal(b)
	}
	if d, _ := reg.Get("srv__exec"); !d.Dangerous || d.Description != "Exec" {
		t.Fatalf("exec %+v", d)
	}
	if d, _ := reg.Get("srv__plain"); d.Dangerous || d.Description != "d" {
		t.Fatalf("plain %+v", d)
	}
	out, err := d.Execute(context.Background(), nil, tools.ExecContext{})
	if err != nil || out != "a\nb" || fc.calls[0] != "read_file {}" {
		t.Fatal(out, err, fc.calls)
	}
	if l := s.ListServers(); len(l) != 1 || len(l[0].ToolNames) != 3 || !l[0].Connected {
		t.Fatal(l)
	}
	s.Dispose()
	if len(reg.List()) != 0 || fc.closed != 1 || len(s.ListServers()) != 0 {
		t.Fatal("not cleaned")
	}
	if strings.Join(ev, ",") != "up:srv:http://x/mcp,down:srv" {
		t.Fatal(ev)
	}
}

func TestConnectFailureCleansUp(t *testing.T) {
	reg := tools.NewInMemory()
	fc := &fakeClient{listErr: errors.New("boom")}
	s := New(Options{GetRegistry: func() tools.Registry { return reg }, CreateClient: func(mcp.ClientConfig) (Client, error) { return fc, nil }})
	if err := s.Connect(ServerConfig{ID: "a", Transport: "sse", URL: "http://x"}); err == nil || err.Error() != "boom" {
		t.Fatal(err)
	}
	if fc.closed != 1 || len(s.ListServers()) != 0 {
		t.Fatal("cleanup")
	}
}

func TestConnectTimeout(t *testing.T) {
	s := New(Options{ConnectTimeoutMs: 20, CreateClient: func(mcp.ClientConfig) (Client, error) { time.Sleep(3 * time.Second); return nil, nil }})
	err := s.Connect(ServerConfig{ID: "a", Transport: "http", URL: "http://x"})
	if err == nil || err.Error() != "mcp connect (a) timed out after 1020ms" {
		t.Fatal(err)
	}
}

func TestBuildTransportErrors(t *testing.T) {
	cases := map[string]ServerConfig{
		"MCP server 'a': url required for http":                                              {ID: "a", Transport: "websocket"},
		"MCP server 'a': websocket without http(s) url is not supported; use http/sse/stdio": {ID: "a", Transport: "websocket", URL: "ws://x"},
		"MCP server 'a': command required for stdio":                                         {ID: "a", Transport: "stdio", Command: " "},
		"MCP server 'a': unsupported transport 'x'":                                          {ID: "a", Transport: "x"},
		"MCP server 'a': url required for sse":                                               {ID: "a", Transport: "sse"},
	}
	for want, c := range cases {
		if _, err := BuildTransport(c); err == nil || err.Error() != want {
			t.Errorf("%v != %q", err, want)
		}
	}
	b, _ := BuildTransport(ServerConfig{ID: "a", Transport: "stdio", Command: " npx ", Args: []string{"-y", "pkg"}})
	if b.DisplayURL != "npx -y pkg" || b.Stdio == nil {
		t.Fatal(b)
	}
}

func TestFormatAndDanger(t *testing.T) {
	if _, err := FormatToolResult(mustParse(`{"isError":true,"content":[{"type":"text","text":""}]}`)); err.Error() != "MCP tool returned an error" {
		t.Fatal(err)
	}
	if _, err := FormatToolResult(mustParse(`{"isError":true,"content":[{"type":"text","text":"x"},{"type":"image"},{"type":"text","text":"y"}]}`)); err.Error() != "x\ny" {
		t.Fatal(err)
	}
	if v, _ := FormatToolResult(mustParse(`{"structuredContent":null,"content":[]}`)); v != nil {
		t.Fatal(v)
	}
	if v, _ := FormatToolResult(mustParse(`{"content":[{"type":"text","text":""}]}`)); v != "" {
		t.Fatal(v)
	}
	if v, _ := FormatToolResult(mustParse(`{}`)); v != nil {
		t.Fatal(v)
	}
	for name, want := range map[string]bool{"get_weather": false, "run_command": true, "runCommand": true, "rerun": false, "file-delete": true, "x\u00a0send": true, "sender": false} {
		if got := InferToolDanger(u.NewObj("name", name), "http"); got != want {
			t.Errorf("%s: %v", name, got)
		}
	}
	if !InferToolDanger(u.NewObj("name", "get"), "stdio") || InferToolDanger(mustParse(`{"name":"exec","annotations":{"readOnlyHint":true}}`), "stdio") {
		t.Fatal("stdio/readOnly")
	}
}

func TestServersFromEnv(t *testing.T) {
	env := map[string]string{"MCP_SERVERS": ` [{"id":" a ","transport":"stdio","command":"npx","args":[1,true,null,"x"],"env":{"K":1}},{"id":"b","name":" ","transport":"ws"},{"id":"c","name":" C ","transport":"http","url":"http://c","headers":{"Z":"1","A":"2"}},5,null]`, "MCP_AUTO_CONNECT": " Yes "}
	look := func(k string) (string, bool) { v, ok := env[k]; return v, ok }
	got := ServersFromEnv(look)
	if len(got) != 2 || got[0].ID != "a" || got[0].Name != "a" || strings.Join(got[0].Args, "|") != "1|true|null|x" || got[0].Env[0] != [2]string{"K", "1"} || got[1].Name != "C" || got[1].Headers[0][0] != "Z" {
		t.Fatalf("%+v", got)
	}
	if !AutoConnectFromEnv(look) {
		t.Fatal("auto")
	}
	Warnf = func(string, ...any) {}
	env["MCP_SERVERS"] = "{"
	if len(ServersFromEnv(look)) != 0 {
		t.Fatal("bad json")
	}
}
