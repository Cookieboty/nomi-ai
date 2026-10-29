//go:build !windows

package drivers

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodeproc"
)

func spawnSh(cmd string, args []string, cwd string) clisdk.ChildLike {
	return clisdk.ProcChild{Child: nodeproc.Spawn(cmd, args, nodeproc.Options{Cwd: cwd})}
}

func lineParser() func(string) []Ev {
	return func(l string) []Ev {
		if l == "null" {
			panic(jsrt.JSThrow{Name: "TypeError", Message: "Cannot read properties of null (reading 'description')"})
		}
		if l == "done" {
			return []Ev{O("type", "done", "sessionId", "s1")}
		}
		return []Ev{O("type", "text-delta", "text", l)}
	}
}

func TestExecDriverTurn(t *testing.T) {
	n := 0
	var events []string
	var res TurnResult
	var err error
	jsrt.Run(func() {
		d := NewExecDriver(ExecDriverOptions{
			Spawn: spawnSh, Command: "sh", Cwd: "/",
			Args:   func(TurnInput, *string) []string { return []string{"-c", "printf 'a\\nb\\ndone\\ntail'"} },
			Parser: lineParser,
			NewID:  func() string { n++; return "t" + util.FormatNumber(float64(n)) },
		})
		d.On(func(e SessionEvent) {
			if e != nil {
				events = append(events, util.Stringify(e))
			}
		})
		res, err = jsrt.Await(d.Send(TurnInput{Text: "hi"}))
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := util.Stringify(res); got != `{"turnId":"t1","stopReason":"end_turn","text":"abtail","sessionId":"s1"}` {
		t.Fatal(got)
	}
	if len(events) != 4 || events[3] != `{"kind":"harness","event":{"type":"text-delta","text":"tail"},"turnId":"t1","tail":true}` {
		t.Fatal(events)
	}
}

func TestExecDriverExitCodeAndENOENT(t *testing.T) {
	jsrt.Run(func() {
		d := NewExecDriver(ExecDriverOptions{Spawn: spawnSh, Command: "sh", Parser: lineParser,
			Args: func(TurnInput, *string) []string { return []string{"-c", "exit 7"} }})
		_, err := jsrt.Await(d.Send(TurnInput{}))
		if err == nil || err.Error() != "exit code 7" {
			t.Fatal(err)
		}
		d2 := NewExecDriver(ExecDriverOptions{Spawn: spawnSh, Command: "no-such-cli-b7", Parser: lineParser,
			Args: func(TurnInput, *string) []string { return nil }})
		_, err = jsrt.Await(d2.Send(TurnInput{}))
		if err == nil || err.Error() != "spawn no-such-cli-b7 ENOENT" {
			t.Fatal(err)
		}
	})
}

// Node：解析器在 stdout 'data' 监听里抛出 → uncaughtException；本 chunk 余下行丢弃，解析器状态保留。
func TestExecDriverParserThrow(t *testing.T) {
	var uncaught []string
	old := jsrt.Uncaught
	jsrt.Uncaught = func(e error) { uncaught = append(uncaught, e.Error()) }
	defer func() { jsrt.Uncaught = old }()
	var res TurnResult
	jsrt.Run(func() {
		d := NewExecDriver(ExecDriverOptions{Spawn: spawnSh, Command: "sh", Parser: lineParser,
			NewID: func() string { return "t" },
			Args: func(TurnInput, *string) []string {
				return []string{"-c", "printf 'a\\nnull\\nlost\\n'; sleep 0.2; printf 'b\\ndone\\n'"}
			}})
		res, _ = jsrt.Await(d.Send(TurnInput{}))
		if len(uncaught) != 1 {
			t.Fatal(uncaught)
		}
	})
	if got := util.Stringify(res); got != `{"turnId":"t","stopReason":"end_turn","text":"ab","sessionId":"s1"}` {
		t.Fatal(got)
	}
}

func TestStreamJsonDriverControlAndTurn(t *testing.T) {
	jsrt.Run(func() {
		// 回显 CLI：读一行 stdin，按类型回复
		script := `while IFS= read -r l; do case "$l" in
*control_request*) id=$(printf '%s' "$l" | sed 's/.*"request_id":"\([^"]*\)".*/\1/'); printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s"}}\n' "$id";;
*'"type":"user"'*) printf 'x\ndone\n';;
esac; done`
		n := 0
		d := NewStreamJsonDriver(StreamJsonDriverOptions{
			Child:     spawnSh("sh", []string{"-c", script}, ""),
			ParseLine: lineParser(),
			NewID:     func() string { n++; return "id" + util.FormatNumber(float64(n)) },
		})
		if _, err := jsrt.Await(d.SetPermissionMode("plan")); err != nil {
			t.Fatal(err)
		}
		r, err := jsrt.Await(d.Send(TurnInput{Text: "hi"}))
		if err != nil || util.Stringify(r) != `{"turnId":"id2","stopReason":"end_turn","text":"x","sessionId":"s1"}` {
			t.Fatal(err, util.Stringify(r))
		}
		var health string
		d.On(func(e SessionEvent) {
			if e != nil && e.Get("kind") == "health" {
				health = util.Stringify(e)
			}
		})
		it := d.Events()
		jsrt.Await(d.Close())
		for {
			if _, ok := it.Next(); !ok {
				break
			}
		}
		if health != `{"kind":"health","state":"exited","code":null}` {
			t.Fatal(health)
		}
	})
}
