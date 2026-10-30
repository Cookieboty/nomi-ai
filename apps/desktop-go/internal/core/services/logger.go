package services

// LoggerService.ts 的 1:1 移植：分级（ERROR<WARN<INFO<DEBUG）、setLevel/getLevel、控制台一行
// `${ISO} ${LEVEL} ${[ctx] }${message}${ meta}`（打包后控制台只出 WARN/ERROR，NOMI_DEBUG=1 恢复），
// 文件 userData/logs/app.log 每行 JSON {timestamp,level,message,meta,context}，攒 100ms 异步追加、
// ERROR 立即写，>10MB 轮转 app.1..app.4.log；meta 按 key 名脱敏（utils/redact.ts）。

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

type LogLevel int

const (
	ERROR LogLevel = 0
	WARN  LogLevel = 1
	INFO  LogLevel = 2
	DEBUG LogLevel = 3
)

func (l LogLevel) String() string {
	switch l {
	case ERROR:
		return "ERROR"
	case WARN:
		return "WARN"
	case INFO:
		return "INFO"
	case DEBUG:
		return "DEBUG"
	}
	return "undefined"
}

const (
	maxLogSize  = 10 * 1024 * 1024
	maxLogFiles = 5
	flushMS     = 100 * time.Millisecond
)

// LoggerOptions：LogDir = paths.logs()；Packaged = app.isPackaged()；Now/Stdout/Stderr 供测试替换
type LoggerOptions struct {
	LogDir   string
	Packaged func() bool
	Now      func() time.Time
	Stdout   io.Writer
	Stderr   io.Writer
	Getenv   func(string) string
}

type LoggerService struct {
	o        LoggerOptions
	mu       sync.Mutex
	level    LogLevel
	logDir   string
	logFile  string
	pending  []string
	fileSize int64
	writing  bool
	timer    *time.Timer
	dirReady bool
	idle     *sync.Cond // writing 变为 false 时广播（替代 WaitGroup：Add 与 Wait 并发会 panic）
}

func NewLogger(o LoggerOptions) *LoggerService {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Stdout == nil {
		o.Stdout = os.Stdout
	}
	if o.Stderr == nil {
		o.Stderr = os.Stderr
	}
	if o.Getenv == nil {
		o.Getenv = os.Getenv
	}
	if o.Packaged == nil {
		o.Packaged = func() bool { return false }
	}
	l := &LoggerService{o: o, level: INFO, logDir: o.LogDir, logFile: filepath.Join(o.LogDir, "app.log"), fileSize: -1}
	l.ensureLogDirectory()
	return l
}

func (l *LoggerService) Error(m string, kv ...any) { l.Log(ERROR, m, MetaOf(kv...), "") }
func (l *LoggerService) Warn(m string, kv ...any)  { l.Log(WARN, m, MetaOf(kv...), "") }
func (l *LoggerService) Info(m string, kv ...any)  { l.Log(INFO, m, MetaOf(kv...), "") }
func (l *LoggerService) Debug(m string, kv ...any) { l.Log(DEBUG, m, MetaOf(kv...), "") }

func (l *LoggerService) SetLevel(v LogLevel)    { l.mu.Lock(); l.level = v; l.mu.Unlock() }
func (l *LoggerService) GetLevel() LogLevel     { l.mu.Lock(); defer l.mu.Unlock(); return l.level }
func (l *LoggerService) GetLogFilePath() string { return l.logFile }

// Undefined：meta 缺省（JSON 里不出现 meta 键）
type undefined struct{}

var Undefined any = undefined{}

// MetaOf：Go 调用约定 → Node 的 meta 参数。无参 = undefined；一个参数 = 原值；
// 偶数个且键是字符串 = 按序对象 { k: v, ... }；其它 = 数组。
func MetaOf(kv ...any) any {
	switch len(kv) {
	case 0:
		return Undefined
	case 1:
		return kv[0]
	}
	if len(kv)%2 == 0 {
		o := util.NewObj()
		ok := true
		for i := 0; i < len(kv); i += 2 {
			k, isStr := kv[i].(string)
			if !isStr {
				ok = false
				break
			}
			o.Set(k, kv[i+1])
		}
		if ok {
			return o
		}
	}
	return kv
}

func isoString(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// Log = log(level, message, meta, context)；meta 传 Undefined 表示缺省，context "" 表示缺省
func (l *LoggerService) Log(level LogLevel, message string, meta any, context string) {
	l.mu.Lock()
	if level > l.level {
		l.mu.Unlock()
		return
	}
	l.mu.Unlock()
	ts := isoString(l.o.Now())
	hasMeta := meta != Undefined
	var metaJSON string
	if hasMeta {
		metaJSON = redactJSON(meta)
	}
	// 控制台
	if !(level > WARN && l.o.Packaged() && l.o.Getenv("NOMI_DEBUG") != "1") {
		ctx := ""
		if context != "" {
			ctx = "[" + context + "] "
		}
		ms := ""
		if hasMeta && truthyJSON(metaJSON) {
			ms = " " + metaJSON
		}
		w := l.o.Stdout
		if level <= WARN {
			w = l.o.Stderr
		}
		fmt.Fprintln(w, ts+" "+level.String()+" "+ctx+message+ms)
	}
	// 文件
	var b strings.Builder
	b.WriteString(`{"timestamp":`)
	b.WriteString(util.Stringify(ts))
	b.WriteString(`,"level":`)
	b.WriteString(fmt.Sprint(int(level)))
	b.WriteString(`,"message":`)
	b.WriteString(util.Stringify(message))
	if hasMeta && metaJSON != "" {
		b.WriteString(`,"meta":`)
		b.WriteString(metaJSON)
	}
	if context != "" {
		b.WriteString(`,"context":`)
		b.WriteString(util.Stringify(context))
	}
	b.WriteString("}\n")
	l.mu.Lock()
	l.pending = append(l.pending, b.String())
	if level == ERROR {
		l.scheduleFlush(0)
	} else {
		l.scheduleFlush(flushMS)
	}
	l.mu.Unlock()
}

// truthyJSON：entry.meta 为假值（null/false/0/""）时控制台不带 meta
func truthyJSON(s string) bool {
	switch s {
	case "", "null", "false", "0", `""`, "-0":
		return false
	}
	return true
}

// scheduleFlush：持锁调用
func (l *LoggerService) scheduleFlush(d time.Duration) {
	if l.timer != nil {
		if d > 0 {
			return
		}
		l.timer.Stop()
	}
	l.timer = time.AfterFunc(d, func() {
		l.mu.Lock()
		l.timer = nil
		l.mu.Unlock()
		l.Flush()
	})
}

// takeBatch：持锁调用
func (l *LoggerService) takeBatch() (string, bool) {
	if len(l.pending) == 0 {
		return "", false
	}
	if !l.dirReady {
		l.ensureLogDirectory()
	}
	batch := strings.Join(l.pending, "")
	l.pending = nil
	if l.fileSize < 0 {
		if st, err := os.Stat(l.logFile); err == nil {
			l.fileSize = st.Size()
		} else {
			l.fileSize = 0
		}
	}
	if l.fileSize > maxLogSize {
		l.rotateLogFile()
		l.fileSize = 0
	}
	return batch, true
}

func appendFile(p, s string) error {
	f, err := os.OpenFile(p, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o666)
	if err != nil {
		return err
	}
	_, err = f.WriteString(s)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

// Flush：异步写出缓冲（同时只有一次写入在途）
func (l *LoggerService) Flush() {
	l.mu.Lock()
	if l.writing {
		l.mu.Unlock()
		return
	}
	batch, ok := l.takeBatch()
	if !ok {
		l.mu.Unlock()
		return
	}
	l.writing = true
	l.mu.Unlock()
	go func() {
		err := appendFile(l.logFile, batch)
		if os.IsNotExist(err) {
			l.mu.Lock()
			l.ensureLogDirectory()
			l.fileSize = 0
			l.mu.Unlock()
			err = appendFile(l.logFile, batch)
		}
		l.mu.Lock()
		l.writing = false
		l.idleCond().Broadcast()
		if err != nil {
			fmt.Fprintln(l.o.Stderr, "Failed to write to log file:", err)
		} else {
			l.fileSize += int64(len(batch))
		}
		if len(l.pending) > 0 {
			l.scheduleFlush(0)
		}
		l.mu.Unlock()
	}()
}

// FlushSync：进程退出时同步写完（= process.once('exit', flushSync)，由宿主退出路径调用）
func (l *LoggerService) FlushSync() {
	l.mu.Lock()
	defer l.mu.Unlock()
	for l.writing {
		l.idleCond().Wait()
	}
	if l.timer != nil {
		l.timer.Stop()
		l.timer = nil
	}
	batch, ok := l.takeBatch()
	if !ok {
		return
	}
	if err := appendFile(l.logFile, batch); err != nil {
		fmt.Fprintln(l.o.Stderr, "Failed to write to log file:", err)
		return
	}
	l.fileSize += int64(len(batch))
}

func (l *LoggerService) ensureLogDirectory() {
	if err := os.MkdirAll(l.logDir, 0o777); err != nil {
		fmt.Fprintln(l.o.Stderr, "Failed to create log directory:", err)
		return
	}
	l.dirReady = true
}

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

func (l *LoggerService) rotateLogFile() {
	oldest := filepath.Join(l.logDir, fmt.Sprintf("app.%d.log", maxLogFiles-1))
	if exists(oldest) {
		if err := os.Remove(oldest); err != nil {
			fmt.Fprintln(l.o.Stderr, "Failed to rotate log file:", err)
			return
		}
	}
	for i := maxLogFiles - 2; i >= 0; i-- {
		cur := l.logFile
		if i != 0 {
			cur = filepath.Join(l.logDir, fmt.Sprintf("app.%d.log", i))
		}
		if exists(cur) {
			if err := os.Rename(cur, filepath.Join(l.logDir, fmt.Sprintf("app.%d.log", i+1))); err != nil {
				fmt.Fprintln(l.o.Stderr, "Failed to rotate log file:", err)
				return
			}
		}
	}
}

// CleanOldLogs = cleanOldLogs(daysToKeep)
func (l *LoggerService) CleanOldLogs(daysToKeep int) {
	ents, err := os.ReadDir(l.logDir)
	if err != nil {
		l.Error("Failed to clean old logs", util.NewObj("error", err.Error()))
		return
	}
	cutoff := l.o.Now().Add(-time.Duration(daysToKeep) * 24 * time.Hour)
	for _, e := range ents {
		p := filepath.Join(l.logDir, e.Name())
		st, err := os.Stat(p)
		if err != nil {
			l.Error("Failed to clean old logs", util.NewObj("error", err.Error()))
			return
		}
		if st.ModTime().Before(cutoff) {
			if err := os.Remove(p); err != nil {
				l.Error("Failed to clean old logs", util.NewObj("error", err.Error()))
				return
			}
			l.Info("Cleaned old log file: " + e.Name())
		}
	}
}

// idleCond：调用方须持有 l.mu
func (l *LoggerService) idleCond() *sync.Cond {
	if l.idle == nil {
		l.idle = sync.NewCond(&l.mu)
	}
	return l.idle
}

// StdWriter：标准库 log 的输出接到这里（log.SetOutput），让 log.Printf 也进 userData/logs（控制台照常由 Log 输出）。
// 含 "panicked" 的记 ERROR（契约处理函数的 panic），其余 INFO
func (l *LoggerService) StdWriter(context string) io.Writer {
	return stdWriter{l: l, context: context}
}

type stdWriter struct {
	l       *LoggerService
	context string
}

func (w stdWriter) Write(p []byte) (int, error) {
	msg := strings.TrimRight(string(p), "\n")
	level := INFO
	if strings.Contains(msg, "panicked") {
		level = ERROR
	}
	w.l.Log(level, msg, Undefined, w.context)
	return len(p), nil
}
