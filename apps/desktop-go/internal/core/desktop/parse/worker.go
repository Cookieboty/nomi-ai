package parse

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"runtime/debug"
	"runtime/metrics"
	"strconv"
	"sync"
	"time"
)

// 对应 runParse.ts 的工具子进程（Electron utilityProcess + worker.ts）：
// 宿主把自身可执行文件以 NOMI_PARSE_WORKER=1 重新拉起，stdin 收 {path,maxBytes}、stdout 回 ParseResult。
// 堆超过 memoryMb 时子进程以 V8 OOM 同样的方式异常退出，父进程报 crashed（带真实退出码）。

const workerEnv = "NOMI_PARSE_WORKER"

var (
	workerMu  sync.RWMutex
	workerExe string
)

// EnableWorker 由宿主（main）调用，等价于 processes 端口可用；未调用时退回进程内解析（单测 / 无界面宿主）
func EnableWorker(exe string) {
	workerMu.Lock()
	workerExe = exe
	workerMu.Unlock()
}

func WorkerAvailable() bool {
	workerMu.RLock()
	defer workerMu.RUnlock()
	if workerExe == "" {
		return false
	}
	_, err := os.Stat(workerExe)
	return err == nil
}

// IsWorker：当前进程是否是解析子进程
func IsWorker() bool { return os.Getenv(workerEnv) == "1" }

type workerReq struct {
	Path     string `json:"path"`
	MaxBytes int64  `json:"maxBytes"`
}

// WorkerMain 解析子进程入口（worker.ts）
func WorkerMain() {
	mem, _ := strconv.Atoi(os.Getenv(workerEnv + "_MEM_MB"))
	if mem > 0 {
		limit := uint64(mem) << 20
		debug.SetMemoryLimit(int64(limit))
		go func() {
			s := []metrics.Sample{{Name: "/memory/classes/heap/objects:bytes"}}
			for range time.Tick(20 * time.Millisecond) {
				metrics.Read(s)
				if s[0].Value.Uint64() > limit {
					os.Stderr.WriteString("FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n")
					os.Exit(134)
				}
			}
		}()
	}
	var req workerReq
	out := json.NewEncoder(os.Stdout)
	if err := json.NewDecoder(os.Stdin).Decode(&req); err != nil {
		os.Exit(1)
	}
	r := func() (r ParseResult) {
		defer func() {
			if v := recover(); v != nil {
				if e, ok := v.(*Error); ok {
					r = ParseResult{Code: e.Code, Message: e.Message}
					return
				}
				r = ParseResult{Code: "parse_failed", Message: fmt.Sprint(v)}
			}
		}()
		st, err := os.Stat(req.Path)
		if err != nil {
			panic(nodeFSErr(err, "stat", req.Path))
		}
		if !st.Mode().IsRegular() {
			panic(&Error{"not_file", "不是文件"})
		}
		if st.Size() > req.MaxBytes {
			panic(&Error{"too_large", "文件过大（" + strconv.FormatInt(st.Size(), 10) + " 字节）"})
		}
		buf, err := os.ReadFile(req.Path)
		if err != nil {
			panic(nodeFSErr(err, "open", req.Path))
		}
		return ParseResult{OK: true, Extracted: Extract(buf, req.Path)}
	}()
	_ = out.Encode(r)
}

func parseInWorker(filePath string, maxBytes int64, memMb int, timeoutMs float64) ParseResult {
	workerMu.RLock()
	exe := workerExe
	workerMu.RUnlock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cmd := exec.CommandContext(ctx, exe)
	cmd.Env = append(os.Environ(), workerEnv+"=1", workerEnv+"_MEM_MB="+strconv.Itoa(memMb))
	hideWindow(cmd)
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		return ParseResult{Code: "crashed", Message: "解析进程异常退出（null），可能超出内存限制"}
	}
	_ = json.NewEncoder(stdin).Encode(workerReq{filePath, maxBytes})
	_ = stdin.Close()
	type msg struct {
		r  ParseResult
		ok bool
	}
	got := make(chan msg, 1)
	go func() {
		var raw json.RawMessage
		if json.NewDecoder(stdout).Decode(&raw) != nil {
			got <- msg{}
			return
		}
		var r struct {
			OK      bool   `json:"ok"`
			Code    string `json:"code"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(raw, &r)
		res := ParseResult{OK: r.OK, Code: r.Code, Message: r.Message}
		if r.OK {
			_ = json.Unmarshal(raw, &res.Extracted)
		}
		got <- msg{res, true}
	}()
	timer := time.NewTimer(time.Duration(timeoutMs * float64(time.Millisecond)))
	defer timer.Stop()
	select {
	case m := <-got:
		if m.ok {
			cancel()
			_ = cmd.Wait()
			return m.r
		}
		_ = cmd.Wait()
		code := "null"
		if cmd.ProcessState != nil && cmd.ProcessState.ExitCode() >= 0 {
			code = strconv.Itoa(cmd.ProcessState.ExitCode())
		}
		return ParseResult{Code: "crashed", Message: "解析进程异常退出（" + code + "），可能超出内存限制"}
	case <-timer.C:
		cancel()
		_ = cmd.Wait()
		return ParseResult{Code: "timeout", Message: "解析超时（" + strconv.FormatFloat(timeoutMs/1000, 'f', -1, 64) + "s）"}
	}
}
