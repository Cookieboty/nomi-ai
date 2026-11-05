// Package convstore 是对话窗口（Nomi 对话、CLI 标签的侧栏镜像）的会话存储。
//
// 布局（userData/conversations/）：
//
//	index.json            元信息列表（视图的 ChatSession 去掉 messages，原样保存）+ 每个会话的条数 +
//	                      当前会话 / 最近的 Nomi 会话 + 是否已从视图旧的 localStorage 导入
//	previews.json         { id: 第一条用户消息的前 300 字 }（侧栏搜索用，只在变了时重写）
//	messages/<id>.jsonl   一行一条消息（视图的 ChatMessage，内核不解析，原样保存）
//
// 追加只往 jsonl 末尾写，不重写整份；整份替换（编辑重发、清空、分叉、裁掉最旧的）、索引与预览都是
// 原子写（临时文件 + rename，0600）。内存里只有索引与预览，消息按需从文件读。
//
// 崩溃安全：先写消息文件再写索引（新建 / 导入），先写索引再删消息文件（删除）；没进索引的消息文件
// 当作不存在。追加写了一半的最后一行读的时候跳过，下一次追加前先补一个换行，不会和新消息粘在一起。
package convstore

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
)

// Dir 是 userData 下的目录名
const Dir = "conversations"

const (
	indexFile    = "index.json"
	previewsFile = "previews.json"
	messagesDir  = "messages"
	importSuffix = ".import"
	// 一行消息的上限（含图片缩略图的消息也远小于它）；超过的行读的时候跳过
	maxLineBytes = 32 << 20
)

var (
	// ErrNotFound：索引里没有这个会话
	ErrNotFound = errors.New("conversation not found")
	// ErrBadID：会话 id 不合法（也是文件名，只认字母、数字、_、-）
	ErrBadID = errors.New("invalid conversation id")
	// ErrBadMessage：消息 / 元信息不是 JSON 对象
	ErrBadMessage = errors.New("message must be a JSON object")
)

var idRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// Windows 的保留设备名（加了扩展名也不能当文件名）
var reserved = map[string]bool{"CON": true, "PRN": true, "AUX": true, "NUL": true}

// ValidID：会话 id 能不能当文件名
func ValidID(id string) bool {
	if !idRe.MatchString(id) {
		return false
	}
	u := strings.ToUpper(id)
	if reserved[u] {
		return false
	}
	if len(u) == 4 && (strings.HasPrefix(u, "COM") || strings.HasPrefix(u, "LPT")) && u[3] >= '0' && u[3] <= '9' {
		return false
	}
	return true
}

type entry struct {
	Meta  json.RawMessage `json:"meta"`
	Count int             `json:"count"`
}

type migratedMark struct {
	At    int64 `json:"at"`
	Count int   `json:"count"`
}

type indexDoc struct {
	Version       int           `json:"version"`
	Current       string        `json:"current,omitempty"`
	LastNomi      string        `json:"lastNomi,omitempty"`
	Migrated      *migratedMark `json:"migrated,omitempty"`
	Conversations []entry       `json:"conversations"`
}

// State 是 conversations.state 的返回值
type State struct {
	Conversations []json.RawMessage `json:"conversations"`
	Previews      map[string]string `json:"previews"`
	Counts        map[string]int    `json:"counts"`
	Current       string            `json:"current,omitempty"`
	LastNomi      string            `json:"lastNomi,omitempty"`
	Migrated      bool              `json:"migrated"`
}

// Store：并发安全（一把锁，所有文件操作在锁内做）
type Store struct {
	dir string
	now func() time.Time

	mu       sync.Mutex
	loaded   bool
	doc      indexDoc
	pos      map[string]int // id → doc.Conversations 下标
	previews map[string]string
}

func New(userData string) *Store {
	return &Store{dir: filepath.Join(userData, Dir), now: time.Now}
}

func (s *Store) msgPath(id string) string {
	return filepath.Join(s.dir, messagesDir, id+".jsonl")
}

// load 懒加载索引与预览；读不出来的索引当作空（不覆盖坏文件，先挪到一边）
func (s *Store) load() {
	if s.loaded {
		return
	}
	s.loaded = true
	s.doc = indexDoc{Version: 1}
	s.previews = map[string]string{}
	if b, err := os.ReadFile(filepath.Join(s.dir, indexFile)); err == nil {
		var d indexDoc
		if json.Unmarshal(b, &d) == nil {
			s.doc = d
			s.doc.Version = 1
		} else {
			_ = os.Rename(filepath.Join(s.dir, indexFile), filepath.Join(s.dir, indexFile+".corrupt"))
		}
	}
	if b, err := os.ReadFile(filepath.Join(s.dir, previewsFile)); err == nil {
		_ = json.Unmarshal(b, &s.previews)
		if s.previews == nil {
			s.previews = map[string]string{}
		}
	}
	// 去掉坏行（没有合法 id 的）与重复 id
	kept := s.doc.Conversations[:0]
	s.pos = map[string]int{}
	for _, e := range s.doc.Conversations {
		id := metaID(e.Meta)
		if !ValidID(id) {
			continue
		}
		if _, dup := s.pos[id]; dup {
			continue
		}
		s.pos[id] = len(kept)
		kept = append(kept, e)
	}
	s.doc.Conversations = kept
}

func metaID(meta json.RawMessage) string {
	var m struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(meta, &m) != nil {
		return ""
	}
	return m.ID
}

// normMeta：元信息必须是 JSON 对象，id 合法；want 非空时必须等于它
func normMeta(meta json.RawMessage, want string) (json.RawMessage, string, error) {
	c, err := compactObject(meta)
	if err != nil {
		return nil, "", err
	}
	id := metaID(c)
	if !ValidID(id) || (want != "" && id != want) {
		return nil, "", ErrBadID
	}
	return c, id, nil
}

func compactObject(raw json.RawMessage) (json.RawMessage, error) {
	t := bytes.TrimSpace(raw)
	if len(t) == 0 || t[0] != '{' || !json.Valid(t) {
		return nil, ErrBadMessage
	}
	var buf bytes.Buffer
	if err := json.Compact(&buf, t); err != nil {
		return nil, ErrBadMessage
	}
	return buf.Bytes(), nil
}

// encodeLines：每条消息压成一行（json.Compact 只去掉字符串外的空白，内容原样）
func encodeLines(msgs []json.RawMessage) ([]byte, error) {
	var buf bytes.Buffer
	for _, m := range msgs {
		c, err := compactObject(m)
		if err != nil {
			return nil, err
		}
		buf.Write(c)
		buf.WriteByte('\n')
	}
	return buf.Bytes(), nil
}

func (s *Store) writeIndex() error {
	b, err := json.Marshal(s.doc)
	if err != nil {
		return err
	}
	return utils.WritePrivateFileAtomic(filepath.Join(s.dir, indexFile), b)
}

func (s *Store) writePreviews() error {
	b, err := json.Marshal(s.previews)
	if err != nil {
		return err
	}
	return utils.WritePrivateFileAtomic(filepath.Join(s.dir, previewsFile), b)
}

// setPreview 返回是否变了
func (s *Store) setPreview(id string, p *string) bool {
	if p == nil {
		return false
	}
	if old, ok := s.previews[id]; ok && old == *p {
		return false
	}
	s.previews[id] = *p
	return true
}

// State：索引快照（元信息、预览、条数、指针）
func (s *Store) State() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.load()
	st := State{
		Conversations: make([]json.RawMessage, 0, len(s.doc.Conversations)),
		Previews:      make(map[string]string, len(s.previews)),
		Counts:        make(map[string]int, len(s.doc.Conversations)),
		Current:       s.doc.Current,
		LastNomi:      s.doc.LastNomi,
		Migrated:      s.doc.Migrated != nil,
	}
	for _, e := range s.doc.Conversations {
		id := metaID(e.Meta)
		st.Conversations = append(st.Conversations, e.Meta)
		st.Counts[id] = e.Count
		if p, ok := s.previews[id]; ok {
			st.Previews[id] = p
		}
	}
	return st
}

// Messages 读一个会话的消息（limit > 0 时只要最后 limit 条）。坏行（写了一半）跳过。
func (s *Store) Messages(id string, limit int) ([]json.RawMessage, error) {
	if !ValidID(id) {
		return nil, ErrBadID
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.load()
	i, ok := s.pos[id]
	if !ok {
		return []json.RawMessage{}, nil
	}
	msgs, err := readLines(s.msgPath(id))
	if err != nil {
		return nil, err
	}
	// 条数以文件为准（上次追加后没来得及写索引时会差几条）
	s.doc.Conversations[i].Count = len(msgs)
	if limit > 0 && len(msgs) > limit {
		msgs = msgs[len(msgs)-limit:]
	}
	return msgs, nil
}

func readLines(path string) ([]json.RawMessage, error) {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return []json.RawMessage{}, nil
		}
		return nil, err
	}
	defer f.Close()
	out := []json.RawMessage{}
	r := bufio.NewReaderSize(f, 64<<10)
	for {
		line, err := readLine(r)
		if len(line) > 0 {
			t := bytes.TrimSpace(line)
			if len(t) > 0 && t[0] == '{' && json.Valid(t) {
				out = append(out, json.RawMessage(append([]byte(nil), t...)))
			}
		}
		if err == io.EOF {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
	}
}

// readLine 读一行（不含换行）；超过 maxLineBytes 的整行丢掉
func readLine(r *bufio.Reader) ([]byte, error) {
	var line []byte
	tooLong := false
	for {
		chunk, err := r.ReadSlice('\n')
		if !tooLong {
			if len(line)+len(chunk) > maxLineBytes {
				tooLong, line = true, nil
			} else {
				line = append(line, chunk...)
			}
		}
		if err == bufio.ErrBufferFull {
			continue
		}
		if tooLong {
			line = nil
		}
		return bytes.TrimSuffix(line, []byte{'\n'}), err
	}
}

// appendFile 往 jsonl 末尾追加；文件末尾不是换行（上次写了一半）时先补一个
func appendFile(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	if st, err := f.Stat(); err == nil && st.Size() > 0 {
		last := make([]byte, 1)
		if _, err := f.ReadAt(last, st.Size()-1); err == nil && last[0] != '\n' {
			data = append([]byte{'\n'}, data...)
		}
	}
	_, err = f.Write(data)
	return err
}

// trimSlack：超过上限这么多条才整份重写（不每次追加都重写）
func trimSlack(max int) int {
	if s := max / 10; s > 20 {
		return s
	}
	return 20
}

// AppendInput 见 conversations.append
type AppendInput struct {
	ID       string
	Messages []json.RawMessage
	Meta     json.RawMessage // 可选：追加后的元信息
	Preview  *string
	Max      int
}

// Append 追加消息（不重写已有的）；超过 Max + 余量时整份重写、只留最后 Max 条
func (s *Store) Append(in AppendInput) error {
	if !ValidID(in.ID) {
		return ErrBadID
	}
	data, err := encodeLines(in.Messages)
	if err != nil {
		return err
	}
	var meta json.RawMessage
	if len(in.Meta) > 0 {
		if meta, _, err = normMeta(in.Meta, in.ID); err != nil {
			return err
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.load()
	i, ok := s.pos[in.ID]
	if !ok {
		return ErrNotFound
	}
	path := s.msgPath(in.ID)
	if err := appendFile(path, data); err != nil {
		return err
	}
	e := &s.doc.Conversations[i]
	e.Count += len(in.Messages)
	if in.Max > 0 && e.Count > in.Max+trimSlack(in.Max) {
		if msgs, err := readLines(path); err == nil {
			if len(msgs) > in.Max {
				msgs = msgs[len(msgs)-in.Max:]
			}
			if b, err := encodeLines(msgs); err == nil {
				if err := utils.WritePrivateFileAtomic(path, b); err != nil {
					return err
				}
				e.Count = len(msgs)
			}
		}
	}
	if meta != nil {
		e.Meta = meta
	}
	if s.setPreview(in.ID, in.Preview) {
		if err := s.writePreviews(); err != nil {
			return err
		}
	}
	return s.writeIndex()
}

// Replace 整份替换消息（原子写）
func (s *Store) Replace(id string, msgs []json.RawMessage, meta json.RawMessage, preview *string) error {
	if !ValidID(id) {
		return ErrBadID
	}
	data, err := encodeLines(msgs)
	if err != nil {
		return err
	}
	if len(meta) > 0 {
		if meta, _, err = normMeta(meta, id); err != nil {
			return err
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.load()
	i, ok := s.pos[id]
	if !ok {
		return ErrNotFound
	}
	if err := utils.WritePrivateFileAtomic(s.msgPath(id), data); err != nil {
		return err
	}
	s.doc.Conversations[i].Count = len(msgs)
	if len(meta) > 0 {
		s.doc.Conversations[i].Meta = meta
	}
	if s.setPreview(id, preview) {
		if err := s.writePreviews(); err != nil {
			return err
		}
	}
	return s.writeIndex()
}

// Put 新建会话（排在末尾）或更新元信息；msgs 非 nil 时整份替换消息。返回会话 id。
func (s *Store) Put(meta json.RawMessage, msgs []json.RawMessage, preview *string) (string, error) {
	meta, id, err := normMeta(meta, "")
	if err != nil {
		return "", err
	}
	var data []byte
	if msgs != nil {
		if data, err = encodeLines(msgs); err != nil {
			return "", err
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.load()
	i, exists := s.pos[id]
	// 新建：先写消息文件（哪怕是空的）再进索引
	if msgs != nil || !exists {
		if err := utils.WritePrivateFileAtomic(s.msgPath(id), data); err != nil {
			return "", err
		}
	}
	if exists {
		s.doc.Conversations[i].Meta = meta
		if msgs != nil {
			s.doc.Conversations[i].Count = len(msgs)
		}
	} else {
		s.pos[id] = len(s.doc.Conversations)
		s.doc.Conversations = append(s.doc.Conversations, entry{Meta: meta, Count: len(msgs)})
	}
	if s.setPreview(id, preview) {
		if err := s.writePreviews(); err != nil {
			return "", err
		}
	}
	return id, s.writeIndex()
}

// Delete 删除会话（不存在时什么都不做）：先改索引再删消息文件
func (s *Store) Delete(id string) error {
	if !ValidID(id) {
		return ErrBadID
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.load()
	i, ok := s.pos[id]
	if !ok {
		return nil
	}
	s.doc.Conversations = append(s.doc.Conversations[:i], s.doc.Conversations[i+1:]...)
	s.reindex()
	if s.doc.Current == id {
		s.doc.Current = ""
	}
	if s.doc.LastNomi == id {
		s.doc.LastNomi = ""
	}
	if err := s.writeIndex(); err != nil {
		return err
	}
	if _, ok := s.previews[id]; ok {
		delete(s.previews, id)
		_ = s.writePreviews()
	}
	if err := os.Remove(s.msgPath(id)); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func (s *Store) reindex() {
	s.pos = make(map[string]int, len(s.doc.Conversations))
	for i, e := range s.doc.Conversations {
		s.pos[metaID(e.Meta)] = i
	}
}

// Pointer 的三种值：nil = 不变，"" = 清空，其余 = 设成它
type Pointer = *string

// SetPointers 改当前会话 / 最近的 Nomi 会话（指向的会话由视图保证存在；这里只校验 id 形状）
func (s *Store) SetPointers(current, lastNomi Pointer) error {
	for _, p := range []Pointer{current, lastNomi} {
		if p != nil && *p != "" && !ValidID(*p) {
			return ErrBadID
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.load()
	changed := false
	if current != nil && *current != s.doc.Current {
		s.doc.Current, changed = *current, true
	}
	if lastNomi != nil && *lastNomi != s.doc.LastNomi {
		s.doc.LastNomi, changed = *lastNomi, true
	}
	if !changed {
		return nil
	}
	return s.writeIndex()
}

// ImportInput 见 conversations.import
type ImportInput struct {
	Meta     json.RawMessage
	Messages []json.RawMessage
	Preview  *string
	First    bool
	Final    bool
}

// Import 导入一个旧会话：消息先写进 messages/<id>.jsonl.import（First 时清空），Final 时改名成正式文件
// 并进索引。索引里已有这个 id 时丢掉暂存、不覆盖（返回 false）。中途中断留下的暂存下次 First 时清掉。
func (s *Store) Import(in ImportInput) (bool, error) {
	meta, id, err := normMeta(in.Meta, "")
	if err != nil {
		return false, err
	}
	data, err := encodeLines(in.Messages)
	if err != nil {
		return false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.load()
	staging := s.msgPath(id) + importSuffix
	if _, exists := s.pos[id]; exists {
		_ = os.Remove(staging)
		return false, nil
	}
	if in.First {
		if err := utils.WritePrivateFileAtomic(staging, data); err != nil {
			return false, err
		}
	} else if err := appendFile(staging, data); err != nil {
		return false, err
	}
	if !in.Final {
		return false, nil
	}
	count := 0
	if msgs, err := readLines(staging); err == nil {
		count = len(msgs)
	} else {
		return false, err
	}
	if err := os.Rename(staging, s.msgPath(id)); err != nil {
		return false, err
	}
	s.pos[id] = len(s.doc.Conversations)
	s.doc.Conversations = append(s.doc.Conversations, entry{Meta: meta, Count: count})
	if s.setPreview(id, in.Preview) {
		if err := s.writePreviews(); err != nil {
			return false, err
		}
	}
	return true, s.writeIndex()
}

// MarkMigrated 记下已从视图旧的 localStorage 导入（count = 核对过的会话数）
func (s *Store) MarkMigrated(count int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.load()
	s.doc.Migrated = &migratedMark{At: s.now().UnixMilli(), Count: count}
	return s.writeIndex()
}

// Root：会话目录（数据导出整份打包）
func (s *Store) Root() string { return s.dir }
