package convstore

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func raw(s string) json.RawMessage { return json.RawMessage(s) }

func msgs(ss ...string) []json.RawMessage {
	out := make([]json.RawMessage, len(ss))
	for i, s := range ss {
		out[i] = raw(s)
	}
	return out
}

func strp(s string) *string { return &s }

func stateOf(t *testing.T, s *Store) State {
	t.Helper()
	st, err := s.State()
	if err != nil {
		t.Fatal(err)
	}
	return st
}

func mustPut(t *testing.T, s *Store, meta string, m []json.RawMessage) {
	t.Helper()
	if _, err := s.Put(raw(meta), m, nil); err != nil {
		t.Fatal(err)
	}
}

func contents(t *testing.T, s *Store, id string) []string {
	t.Helper()
	got, err := s.Messages(id, 0)
	if err != nil {
		t.Fatal(err)
	}
	out := make([]string, len(got))
	for i, m := range got {
		out[i] = string(m)
	}
	return out
}

func eq(t *testing.T, got, want []string) {
	t.Helper()
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestPutAppendAndReopen(t *testing.T) {
	ud := t.TempDir()
	s := New(ud)
	mustPut(t, s, `{"id":"c1","name":"A","updatedAt":1}`, nil)
	mustPut(t, s, `{"id":"c2","name":"B"}`, nil)
	if err := s.Append(AppendInput{ID: "c1", Messages: msgs(`{"id":"m1","role":"user","content":"hi 你好  "}`), Meta: raw(`{"id":"c1","name":"hi","updatedAt":2}`), Preview: strp("hi")}); err != nil {
		t.Fatal(err)
	}
	if err := s.Append(AppendInput{ID: "c1", Messages: msgs(`{ "id": "m2", "role": "assistant", "content": "a\nb" }`)}); err != nil {
		t.Fatal(err)
	}
	// 新实例（重启）读同一目录
	r := New(ud)
	st := stateOf(t, r)
	if len(st.Conversations) != 2 || metaID(st.Conversations[0]) != "c1" || metaID(st.Conversations[1]) != "c2" {
		t.Fatalf("order: %s", st.Conversations)
	}
	if string(st.Conversations[0]) != `{"id":"c1","name":"hi","updatedAt":2}` {
		t.Fatalf("meta not updated: %s", st.Conversations[0])
	}
	if st.Counts["c1"] != 2 || st.Counts["c2"] != 0 || st.Previews["c1"] != "hi" {
		t.Fatalf("state: %+v", st)
	}
	// 消息原样（只去掉字符串外的空白），字符串里的换行与转义不动
	eq(t, contents(t, r, "c1"), []string{
		`{"id":"m1","role":"user","content":"hi 你好  "}`,
		`{"id":"m2","role":"assistant","content":"a\nb"}`,
	})
	// 追加不重写：文件就是两行
	b, _ := os.ReadFile(filepath.Join(ud, Dir, messagesDir, "c1.jsonl"))
	if strings.Count(string(b), "\n") != 2 {
		t.Fatalf("file: %q", b)
	}
	if runtime.GOOS != "windows" {
		for _, f := range []string{indexFile, previewsFile, filepath.Join(messagesDir, "c1.jsonl")} {
			st, err := os.Stat(filepath.Join(ud, Dir, f))
			if err != nil || st.Mode().Perm() != 0o600 {
				t.Fatalf("%s perm: %v %v", f, st, err)
			}
		}
	}
	// limit 只要最后几条
	got, _ := r.Messages("c1", 1)
	if len(got) != 1 || !strings.Contains(string(got[0]), "m2") {
		t.Fatalf("limit: %s", got)
	}
}

func TestAppendUnknownAndBadInput(t *testing.T) {
	s := New(t.TempDir())
	if err := s.Append(AppendInput{ID: "nope", Messages: msgs(`{"id":"m"}`)}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("want not found, got %v", err)
	}
	mustPut(t, s, `{"id":"c1"}`, nil)
	for _, bad := range []string{`[1]`, `"x"`, `{"id":`, ``} {
		if err := s.Append(AppendInput{ID: "c1", Messages: msgs(bad)}); !errors.Is(err, ErrBadMessage) {
			t.Fatalf("%q: want bad message, got %v", bad, err)
		}
	}
	// 元信息的 id 必须是这个会话
	if err := s.Append(AppendInput{ID: "c1", Messages: msgs(`{"id":"m"}`), Meta: raw(`{"id":"c2"}`)}); !errors.Is(err, ErrBadID) {
		t.Fatalf("meta id mismatch: %v", err)
	}
	if _, err := s.Put(raw(`{"name":"no id"}`), nil, nil); !errors.Is(err, ErrBadID) {
		t.Fatalf("meta without id: %v", err)
	}
}

func TestIDValidation(t *testing.T) {
	for _, id := range []string{"c_lx1_ab12cd", "old1", "A-b_9"} {
		if !ValidID(id) {
			t.Fatalf("%q should be valid", id)
		}
	}
	for _, id := range []string{"", "..", "../x", "a/b", `a\b`, "a.b", "a:b", "con", "NUL", "com1", "LPT9", strings.Repeat("a", 129), "a b", "中文"} {
		if ValidID(id) {
			t.Fatalf("%q should be invalid", id)
		}
	}
	ud := t.TempDir()
	s := New(ud)
	if _, err := s.Put(raw(`{"id":"../../evil"}`), msgs(`{"id":"m"}`), nil); !errors.Is(err, ErrBadID) {
		t.Fatalf("traversal put: %v", err)
	}
	if _, err := s.Messages("../index", 0); !errors.Is(err, ErrBadID) {
		t.Fatalf("traversal read: %v", err)
	}
	if err := s.Delete("../index"); !errors.Is(err, ErrBadID) {
		t.Fatalf("traversal delete: %v", err)
	}
	if err := s.SetPointers(strp("../x"), nil); !errors.Is(err, ErrBadID) {
		t.Fatalf("bad pointer: %v", err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(ud), "evil.jsonl")); err == nil {
		t.Fatal("wrote outside the store")
	}
}

func TestReplaceForkClearAndTrim(t *testing.T) {
	s := New(t.TempDir())
	mustPut(t, s, `{"id":"a"}`, nil)
	for i := 0; i < 3; i++ {
		_ = s.Append(AppendInput{ID: "a", Messages: msgs(`{"id":"x"}`)})
	}
	if err := s.Replace("a", msgs(`{"id":"e1"}`), nil, strp("edited")); err != nil {
		t.Fatal(err)
	}
	eq(t, contents(t, s, "a"), []string{`{"id":"e1"}`})
	// 分叉 = 新会话带整份消息
	mustPut(t, s, `{"id":"b","name":"copy"}`, msgs(`{"id":"b_0_e1"}`, `{"id":"b_1_x"}`))
	eq(t, contents(t, s, "b"), []string{`{"id":"b_0_e1"}`, `{"id":"b_1_x"}`})
	if stateOf(t, s).Counts["b"] != 2 {
		t.Fatal("fork count")
	}
	// 只改元信息不动消息
	mustPut(t, s, `{"id":"b","name":"renamed"}`, nil)
	eq(t, contents(t, s, "b"), []string{`{"id":"b_0_e1"}`, `{"id":"b_1_x"}`})
	// 清空
	if err := s.Replace("b", []json.RawMessage{}, nil, strp("")); err != nil {
		t.Fatal(err)
	}
	eq(t, contents(t, s, "b"), []string{})
	// 超过上限 + 余量才整份重写，只留最后 max 条
	mustPut(t, s, `{"id":"t"}`, nil)
	for i := 0; i < 25; i++ {
		_ = s.Append(AppendInput{ID: "t", Messages: msgs(`{"id":"m` + string(rune('a'+i)) + `"}`), Max: 3})
	}
	got := contents(t, s, "t")
	if len(got) > 3+trimSlack(3) || got[len(got)-1] != `{"id":"my"}` {
		t.Fatalf("trim: %v", got)
	}
	_ = s.Append(AppendInput{ID: "t", Messages: msgs(`{"id":"last"}`), Max: 3})
	if n := len(contents(t, s, "t")); n > 3+trimSlack(3) {
		t.Fatalf("not trimmed: %d", n)
	}
}

func TestDeleteAndPointers(t *testing.T) {
	ud := t.TempDir()
	s := New(ud)
	mustPut(t, s, `{"id":"a"}`, msgs(`{"id":"m"}`))
	mustPut(t, s, `{"id":"b"}`, nil)
	if err := s.SetPointers(strp("a"), strp("a")); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete("a"); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete("a"); err != nil { // 幂等
		t.Fatal(err)
	}
	st := stateOf(t, New(ud))
	if len(st.Conversations) != 1 || st.Current != "" || st.LastNomi != "" {
		t.Fatalf("after delete: %+v", st)
	}
	if _, err := os.Stat(filepath.Join(ud, Dir, messagesDir, "a.jsonl")); !os.IsNotExist(err) {
		t.Fatal("messages file left behind")
	}
	// 删掉的会话读出来是空的，不复活
	if got := contents(t, s, "a"); len(got) != 0 {
		t.Fatal(got)
	}
	// nil = 不变，"" = 清空
	_ = s.SetPointers(strp("b"), nil)
	_ = s.SetPointers(nil, strp("b"))
	st = stateOf(t, New(ud))
	if st.Current != "b" || st.LastNomi != "b" {
		t.Fatalf("pointers: %+v", st)
	}
	_ = s.SetPointers(strp(""), nil)
	if st := stateOf(t, New(ud)); st.Current != "" || st.LastNomi != "b" {
		t.Fatalf("clear: %+v", st)
	}
}

// 追加写了一半就崩了：读的时候跳过半行，下一次追加不和半行粘在一起
func TestTornAppendIsSkipped(t *testing.T) {
	ud := t.TempDir()
	s := New(ud)
	mustPut(t, s, `{"id":"a"}`, msgs(`{"id":"m1"}`))
	f, _ := os.OpenFile(filepath.Join(ud, Dir, messagesDir, "a.jsonl"), os.O_APPEND|os.O_WRONLY, 0o600)
	_, _ = f.WriteString(`{"id":"m2","content":"hal`)
	_ = f.Close()
	r := New(ud)
	eq(t, contents(t, r, "a"), []string{`{"id":"m1"}`})
	if err := r.Append(AppendInput{ID: "a", Messages: msgs(`{"id":"m3"}`)}); err != nil {
		t.Fatal(err)
	}
	eq(t, contents(t, r, "a"), []string{`{"id":"m1"}`, `{"id":"m3"}`})
	if stateOf(t, r).Counts["a"] != 2 {
		t.Fatal("count follows the file")
	}
}

// 原子写：替换中途留下的临时文件不影响读，原文件要么是旧的要么是新的
func TestAtomicRewriteLeavesNoPartialFile(t *testing.T) {
	ud := t.TempDir()
	s := New(ud)
	mustPut(t, s, `{"id":"a"}`, msgs(`{"id":"old"}`))
	// 模拟上一次替换写临时文件时崩了
	tmp := filepath.Join(ud, Dir, messagesDir, "a.jsonl.tmp-1-x")
	_ = os.WriteFile(tmp, []byte(`{"id":"half`), 0o600)
	tmpIdx := filepath.Join(ud, Dir, "index.json.tmp-1-y")
	_ = os.WriteFile(tmpIdx, []byte(`{"conversations":[`), 0o600)
	r := New(ud)
	eq(t, contents(t, r, "a"), []string{`{"id":"old"}`})
	if err := r.Replace("a", msgs(`{"id":"new"}`), nil, nil); err != nil {
		t.Fatal(err)
	}
	eq(t, contents(t, New(ud), "a"), []string{`{"id":"new"}`})
}

// 索引一致性：没进索引的消息文件当不存在；坏掉的索引挪开、从空开始，不 panic
func TestIndexConsistency(t *testing.T) {
	ud := t.TempDir()
	dir := filepath.Join(ud, Dir)
	_ = os.MkdirAll(filepath.Join(dir, messagesDir), 0o700)
	_ = os.WriteFile(filepath.Join(dir, messagesDir, "orphan.jsonl"), []byte(`{"id":"m"}`+"\n"), 0o600)
	_ = os.WriteFile(filepath.Join(dir, indexFile), []byte(`{"version":1,"conversations":[]}`), 0o600)
	s := New(ud)
	if st := stateOf(t, s); len(st.Conversations) != 0 {
		t.Fatalf("orphan listed: %+v", st)
	}
	if got := contents(t, s, "orphan"); len(got) != 0 {
		t.Fatal("orphan readable")
	}
	if err := s.Append(AppendInput{ID: "orphan", Messages: msgs(`{"id":"x"}`)}); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	// 重复 / 不合法的行在加载时去掉
	_ = os.WriteFile(filepath.Join(dir, indexFile), []byte(`{"version":1,"conversations":[{"meta":{"id":"a"},"count":0},{"meta":{"id":"a"},"count":0},{"meta":{"id":"../x"}},{"meta":{"id":"b"}}]}`), 0o600)
	if st := stateOf(t, New(ud)); len(st.Conversations) != 2 {
		t.Fatalf("dedupe: %s", st.Conversations)
	}
	_ = os.WriteFile(filepath.Join(dir, indexFile), []byte(`{not json`), 0o600)
	r := New(ud)
	// 坏索引挪开、按消息文件重建：orphan 有消息，回来了
	if st := stateOf(t, r); len(st.Conversations) != 1 || st.Migrated {
		t.Fatalf("corrupt index: %+v", st)
	}
	if _, err := os.Stat(filepath.Join(dir, indexFile+".corrupt")); err != nil {
		t.Fatal("corrupt index not kept aside")
	}
}

// 索引坏了：按 messages/*.jsonl 重建（元信息按消息补），「已导入」不丢；再坏一次不覆盖上次挪开的
func TestCorruptIndexIsRebuiltFromMessages(t *testing.T) {
	ud := t.TempDir()
	dir := filepath.Join(ud, Dir)
	s := New(ud)
	mustPut(t, s, `{"id":"old","name":"Old","backend":"nomi"}`, msgs(`{"id":"1","role":"user","content":"  first   question that is quite a bit longer than thirty runes","timestamp":100}`, `{"id":"2","role":"assistant","content":"a","timestamp":200}`))
	mustPut(t, s, `{"id":"new","name":"New"}`, msgs(`{"id":"3","role":"user","content":"你好","timestamp":50}`))
	mustPut(t, s, `{"id":"empty","name":"E"}`, nil)
	if err := s.MarkMigrated(3); err != nil {
		t.Fatal(err)
	}
	// 中途中断的导入暂存不算
	_ = os.WriteFile(filepath.Join(dir, messagesDir, "half.jsonl"+importSuffix), []byte(`{"id":"x"}`+"\n"), 0o600)
	_ = os.WriteFile(filepath.Join(dir, indexFile), []byte(`{"version":1,"conv`), 0o600)

	r := New(ud)
	st := stateOf(t, r)
	if !st.Migrated {
		t.Fatal("migrated flag lost with the index: old localStorage would be imported again")
	}
	if len(st.Conversations) != 2 || st.Counts["old"] != 2 || st.Counts["new"] != 1 {
		t.Fatalf("rebuilt: %s %+v", st.Conversations, st.Counts)
	}
	// 按最早的消息时间排（new 的第一条更早）
	var metas []map[string]any
	for _, c := range st.Conversations {
		var m map[string]any
		_ = json.Unmarshal(c, &m)
		metas = append(metas, m)
	}
	if metas[0]["id"] != "new" || metas[0]["name"] != "你好" || metas[1]["name"] != "first question that is quite a" {
		t.Fatalf("metas: %v", metas)
	}
	if metas[1]["createdAt"] != float64(100) || metas[1]["updatedAt"] != float64(200) || metas[1]["backend"] != "nomi" || metas[1]["recovered"] != true {
		t.Fatalf("meta fields: %v", metas[1])
	}
	eq(t, contents(t, r, "old"), []string{`{"id":"1","role":"user","content":"  first   question that is quite a bit longer than thirty runes","timestamp":100}`, `{"id":"2","role":"assistant","content":"a","timestamp":200}`})
	// 重建后的索引写下来了；能接着写
	if err := r.Append(AppendInput{ID: "old", Messages: msgs(`{"id":"4"}`)}); err != nil {
		t.Fatal(err)
	}
	if st := stateOf(t, New(ud)); st.Counts["old"] != 3 || !st.Migrated {
		t.Fatalf("after rebuild: %+v", st)
	}
	// 再坏一次：上次挪开的不被覆盖
	_ = os.WriteFile(filepath.Join(dir, indexFile), []byte(`]`), 0o600)
	_ = stateOf(t, New(ud))
	ents, _ := os.ReadDir(dir)
	n := 0
	for _, e := range ents {
		if strings.HasPrefix(e.Name(), indexFile+".corrupt") {
			n++
		}
	}
	if n != 2 {
		t.Fatalf("corrupt copies: %d", n)
	}
}

// 索引不见了（被删）：同样按消息文件重建；没有标记 = 还没导入完，视图照常续导（不覆盖已有 id）
func TestMissingIndexIsRebuiltAndMarkerIsBackfilled(t *testing.T) {
	ud := t.TempDir()
	dir := filepath.Join(ud, Dir)
	s := New(ud)
	mustPut(t, s, `{"id":"a"}`, msgs(`{"id":"1","role":"user","content":"hi"}`))
	_ = os.Remove(filepath.Join(dir, indexFile))
	st := stateOf(t, New(ud))
	if len(st.Conversations) != 1 || st.Migrated {
		t.Fatalf("missing index: %+v", st)
	}
	// 只有索引里有「已导入」（旧数据）：加载时补上另一份标记
	_ = os.WriteFile(filepath.Join(dir, indexFile), []byte(`{"version":1,"migrated":{"at":1,"count":1},"conversations":[{"meta":{"id":"a"},"count":1}]}`), 0o600)
	_ = stateOf(t, New(ud))
	if _, err := os.Stat(filepath.Join(dir, migratedFile)); err != nil {
		t.Fatal("marker not backfilled")
	}
	_ = os.WriteFile(filepath.Join(dir, indexFile), []byte(`nope`), 0o600)
	if st := stateOf(t, New(ud)); !st.Migrated || len(st.Conversations) != 1 {
		t.Fatalf("after corrupt: %+v", st)
	}
}

// 索引读不出来（不是不存在）：报错，不当作空、不覆盖
func TestUnreadableIndexFailsInsteadOfEmpty(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("directory as file")
	}
	ud := t.TempDir()
	dir := filepath.Join(ud, Dir)
	_ = os.MkdirAll(filepath.Join(dir, indexFile), 0o700) // 读一个目录：EISDIR
	s := New(ud)
	if _, err := s.State(); err == nil {
		t.Fatal("unreadable index treated as empty")
	}
	if _, err := s.Put(raw(`{"id":"a"}`), nil, nil); err == nil {
		t.Fatal("write over an unreadable index")
	}
	_ = os.Remove(filepath.Join(dir, indexFile))
	if st := stateOf(t, s); len(st.Conversations) != 0 {
		t.Fatalf("retry: %+v", st)
	}
}

func TestImportIsIdempotentAndResumable(t *testing.T) {
	ud := t.TempDir()
	s := New(ud)
	mustPut(t, s, `{"id":"keep","name":"new"}`, msgs(`{"id":"n"}`))
	// 已有的 id 不覆盖
	ok, err := s.Import(ImportInput{Meta: raw(`{"id":"keep","name":"old"}`), Messages: msgs(`{"id":"o"}`), First: true, Final: true})
	if err != nil || ok {
		t.Fatalf("overwrote existing: %v %v", ok, err)
	}
	eq(t, contents(t, s, "keep"), []string{`{"id":"n"}`})
	// 分两次导入；第一次之后「崩了」：没进索引
	if _, err := s.Import(ImportInput{Meta: raw(`{"id":"big"}`), Messages: msgs(`{"id":"1"}`, `{"id":"2"}`), First: true}); err != nil {
		t.Fatal(err)
	}
	r := New(ud)
	if len(stateOf(t, r).Conversations) != 1 {
		t.Fatal("partial import visible")
	}
	// 下次从头再导：first 清掉上次的暂存
	_, _ = r.Import(ImportInput{Meta: raw(`{"id":"big"}`), Messages: msgs(`{"id":"1"}`, `{"id":"2"}`), First: true})
	ok, err = r.Import(ImportInput{Meta: raw(`{"id":"big","name":"Big"}`), Messages: msgs(`{"id":"3"}`), Preview: strp("p"), Final: true})
	if err != nil || !ok {
		t.Fatalf("final: %v %v", ok, err)
	}
	eq(t, contents(t, r, "big"), []string{`{"id":"1"}`, `{"id":"2"}`, `{"id":"3"}`})
	st := stateOf(t, New(ud))
	if st.Counts["big"] != 3 || st.Previews["big"] != "p" || st.Migrated {
		t.Fatalf("state: %+v", st)
	}
	if _, err := os.Stat(filepath.Join(ud, Dir, messagesDir, "big.jsonl"+importSuffix)); !os.IsNotExist(err) {
		t.Fatal("staging left behind")
	}
	// 再导一遍：什么都不变
	ok, _ = r.Import(ImportInput{Meta: raw(`{"id":"big"}`), Messages: msgs(`{"id":"x"}`), First: true, Final: true})
	if ok || len(contents(t, r, "big")) != 3 {
		t.Fatal("re-import changed data")
	}
	if err := r.MarkMigrated(2); err != nil {
		t.Fatal(err)
	}
	if !stateOf(t, New(ud)).Migrated {
		t.Fatal("migrated mark not persisted")
	}
}

// 与契约 isValidConversationId 的用例一致（packages/contract/tests/shell.test.ts）
func TestValidIDMatchesContract(t *testing.T) {
	for _, id := range []string{"a", "c_1-x", strings.Repeat("A", 128), "con1", "com", "comx", "lpt10"} {
		if !ValidID(id) {
			t.Errorf("%q should be valid", id)
		}
	}
	for _, id := range []string{"", "a/b", "a.b", strings.Repeat("A", 129), "con", "CON", "Prn", "aux", "nul", "com0", "COM9", "lpt1"} {
		if ValidID(id) {
			t.Errorf("%q should be invalid", id)
		}
	}
}
