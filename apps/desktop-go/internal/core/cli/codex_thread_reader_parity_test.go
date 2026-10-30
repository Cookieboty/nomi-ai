package cli

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

type fakeCodexWorker struct {
	k         int
	log       *[]string
	throwPost bool
	msg       func(CodexIndexReply)
	err       func(error)
	exit      func(int)
}

func (w *fakeCodexWorker) PostMessage(m CodexIndexRequest) error {
	*w.log = append(*w.log, fmt.Sprintf("post#%d:%d:%s", w.k, m.ID, m.File))
	if w.throwPost {
		return errors.New("DataCloneError")
	}
	return nil
}
func (w *fakeCodexWorker) OnMessage(fn func(CodexIndexReply)) { w.msg = fn }
func (w *fakeCodexWorker) OnError(fn func(error))             { w.err = fn }
func (w *fakeCodexWorker) OnExit(fn func(int))                { w.exit = fn }
func (w *fakeCodexWorker) Terminate()                         { *w.log = append(*w.log, fmt.Sprintf("term#%d", w.k)) }
func (w *fakeCodexWorker) Ref()                               { *w.log = append(*w.log, fmt.Sprintf("ref#%d", w.k)) }
func (w *fakeCodexWorker) Unref()                             { *w.log = append(*w.log, fmt.Sprintf("unref#%d", w.k)) }

func objRows(v any) []*util.Obj {
	out := []*util.Obj{}
	for _, x := range v.([]any) {
		out = append(out, x.(*util.Obj))
	}
	return out
}

func numOpt(o *util.Obj, k string) *int {
	if v, ok := o.Get(k).(float64); ok {
		i := int(v)
		return &i
	}
	return nil
}

func runReaderScenario(sc *util.Obj) []string {
	log := []string{}
	o := sc.Get("opts").(*util.Obj)
	mode, _ := o.Get("spawn").(string)
	n := 0
	var cur *fakeCodexWorker
	opts := CodexThreadReaderOptions{
		TimeoutMs: numOpt(o, "timeoutMs"), IdleMs: numOpt(o, "idleMs"), MaxCrashes: numOpt(o, "maxCrashes"),
		Warn: func(string, ...any) {},
		Local: func(f string) ([]*util.Obj, error) {
			log = append(log, "local:"+f)
			if e, ok := o.Get("localErr").(string); ok {
				return nil, errors.New(e)
			}
			return []*util.Obj{util.NewObj("id", "local", "title", "t-local")}, nil
		},
	}
	switch mode {
	case "null":
		opts.Spawn = func() (CodexIndexWorkerLike, error) { return nil, nil }
	case "throw":
		opts.Spawn = func() (CodexIndexWorkerLike, error) { return nil, errors.New("no worker") }
	default:
		opts.Spawn = func() (CodexIndexWorkerLike, error) {
			n++
			log = append(log, fmt.Sprintf("spawn#%d", n))
			cur = &fakeCodexWorker{k: n, log: &log, throwPost: mode == "fakeThrowPost"}
			return cur, nil
		}
	}
	type rd struct {
		tag    string
		p      *jsrt.Promise[[]*util.Obj]
		logged bool
	}
	var reads []*rd
	var r *CodexThreadReader
	jsrt.Run(func() { r = NewCodexThreadReader(opts) })
	for _, s := range sc.Get("steps").([]any) {
		st := s.(*util.Obj)
		op := st.Get("op").(string)
		if op == "wait" {
			time.Sleep(time.Duration(st.Get("ms").(float64)) * time.Millisecond)
		}
		jsrt.Run(func() {
			switch op {
			case "read":
				tag := st.Get("tag").(string)
				reads = append(reads, &rd{tag: tag, p: r.Read("/db/" + tag + ".sqlite")})
			case "msg":
				id := int(st.Get("id").(float64))
				if st.Get("ok").(bool) {
					cur.msg(CodexIndexReply{ID: id, Ok: true, Rows: objRows(st.Get("rows"))})
				} else {
					cur.msg(CodexIndexReply{ID: id, Message: st.Get("message").(string)})
				}
			case "error":
				cur.err(errors.New(st.Get("message").(string)))
			case "exit":
				cur.exit(int(st.Get("code").(float64)))
			case "shutdown":
				r.Shutdown()
			case "state":
				log = append(log, fmt.Sprintf("state:inProc=%v:running=%v", r.InProcess(), r.Running()))
			}
			for _, x := range reads {
				if !x.logged && x.p.Settled() {
					x.logged = true
					v, err := x.p.Result()
					if err != nil {
						log = append(log, x.tag+":err:"+err.Error())
					} else {
						log = append(log, x.tag+":ok:"+util.Stringify(v))
					}
				}
			}
		})
	}
	out := append([]string{}, log...)
	jsrt.Run(func() { r.Shutdown() }) // 清理（不计入日志，Node 侧未调用）
	return out
}

func TestCodexThreadReaderGolden(t *testing.T) {
	p, _ := paritytest.Golden(t, "b7s_reader.json", filepath.Join("testdata", "b7s_reader.json"))
	g := readGoldenObj(t, p)
	n := 0
	for _, s := range g.Get("scenarios").([]any) {
		sc := s.(*util.Obj)
		want := []string{}
		for _, x := range sc.Get("log").([]any) {
			want = append(want, x.(string))
		}
		got := runReaderScenario(sc)
		if strings.Join(got, "\n") != strings.Join(want, "\n") {
			t.Errorf("%s\n got  %q\n want %q", sc.Get("name"), got, want)
		}
		n++
	}
	t.Logf("codexThreadReader parity: %d scenarios", n)
}

// 默认 goroutine worker 与主线程读取结果一致（真实 sqlite）。
func TestCodexThreadReaderGoroutine(t *testing.T) {
	db := filepath.Join(t.TempDir(), "state_5.sqlite")
	makeCodexThreadsDB(t, db)
	want := util.Stringify(ReadCodexThreads(db))
	r := NewCodexThreadReader(CodexThreadReaderOptions{Spawn: func() (CodexIndexWorkerLike, error) { return newGoWorker(), nil }})
	for i := 0; i < 3; i++ {
		var p *jsrt.Promise[[]*util.Obj]
		jsrt.Run(func() { p = r.Read(db) })
		<-p.Done()
		v, err := p.Result()
		if err != nil || util.Stringify(v) != want {
			t.Fatalf("round %d: %v %s want %s", i, err, util.Stringify(v), want)
		}
	}
	jsrt.Run(func() {
		if !r.Running() {
			t.Error("worker should be reused")
		}
		r.Shutdown()
	})
}

func makeCodexThreadsDB(t *testing.T, file string) {
	db, err := sql.Open("sqlite", file)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, s := range []string{
		`CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, archived INTEGER, extra TEXT)`,
		`INSERT INTO threads VALUES ('a','T1','/w',0,'x'),('b',NULL,'/v',1,'y')`,
	} {
		if _, err := db.Exec(s); err != nil {
			t.Fatal(err)
		}
	}
}

func readGoldenObj(t *testing.T, p string) *util.Obj {
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	v, err := util.ParseString(string(b))
	if err != nil {
		t.Fatal(err)
	}
	return v.(*util.Obj)
}
