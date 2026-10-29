package parse

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strconv"
	"time"
)

// ParseOptions 对应 ParseOptions（memoryMb 无对应：D-B6-7 进程内解析）
type ParseOptions struct {
	TimeoutMs float64
	MaxBytes  int64
}

// ParseResult：ok=true 时带 Extracted 字段；否则 code/message
type ParseResult struct {
	OK bool `json:"ok"`
	Extracted
	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}

func (r ParseResult) MarshalJSON() ([]byte, error) {
	if r.OK {
		type ok struct {
			OK bool `json:"ok"`
			Extracted
		}
		return jsonMarshal(ok{true, r.Extracted})
	}
	return jsonMarshal(struct {
		OK      bool   `json:"ok"`
		Code    string `json:"code"`
		Message string `json:"message"`
	}{false, r.Code, r.Message})
}

// nodeFSErr：模拟 Node fs 错误的 code 与 message
func nodeFSErr(err error, syscall, p string) *Error {
	code, desc := "", ""
	switch {
	case errors.Is(err, fs.ErrNotExist):
		code, desc = "ENOENT", "no such file or directory"
	case errors.Is(err, fs.ErrPermission):
		code, desc = "EACCES", "permission denied"
	default:
		return parseErr(err.Error())
	}
	return &Error{code, fmt.Sprintf("%s: %s, %s '%s'", code, desc, syscall, p)}
}

// ParseFile 对应 parseFile（worker 语义：先校验是文件、大小，再超时内解析）
func ParseFile(filePath string, opts ParseOptions) ParseResult {
	timeout := opts.TimeoutMs
	if timeout == 0 {
		timeout = 20_000
	}
	maxBytes := opts.MaxBytes
	if maxBytes == 0 {
		maxBytes = 50 * 1024 * 1024
	}
	ch := make(chan ParseResult, 1)
	go func() {
		defer func() {
			if v := recover(); v != nil {
				if e, ok := v.(*Error); ok {
					ch <- ParseResult{Code: e.Code, Message: e.Message}
					return
				}
				ch <- ParseResult{Code: "crashed", Message: "解析进程异常退出（1），可能超出内存限制"}
			}
		}()
		st, err := os.Stat(filePath)
		if err != nil {
			panic(nodeFSErr(err, "stat", filePath))
		}
		if !st.Mode().IsRegular() {
			panic(&Error{"not_file", "不是文件"})
		}
		if st.Size() > maxBytes {
			panic(&Error{"too_large", "文件过大（" + strconv.FormatInt(st.Size(), 10) + " 字节）"})
		}
		buf, err := os.ReadFile(filePath)
		if err != nil {
			panic(nodeFSErr(err, "open", filePath))
		}
		ch <- ParseResult{OK: true, Extracted: Extract(buf, filePath)}
	}()
	select {
	case r := <-ch:
		return r
	case <-time.After(time.Duration(timeout * float64(time.Millisecond))):
		return ParseResult{Code: "timeout", Message: "解析超时（" + strconv.FormatFloat(timeout/1000, 'f', -1, 64) + "s）"}
	}
}
