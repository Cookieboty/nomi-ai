package mcpserve

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sync"
	"time"
)

// BridgeFlag：Nomi 可执行文件以 `--computer-mcp <token 文件>` 启动时只做 stdio ↔ HTTP 转发（不起界面）
const BridgeFlag = "--computer-mcp"

// Bridge：读 stdin 上的 JSON-RPC（一行一条），POST 给内核的端点，把回复写回 stdout。
// 请求并发转发（等用户确认的 tools/call 不挡住 ping），写回按行加锁。返回进程退出码。
func Bridge(tokenFile string, in io.Reader, out io.Writer, errOut io.Writer) int {
	b, err := os.ReadFile(tokenFile)
	if err != nil {
		fmt.Fprintln(errOut, "nomi computer mcp: cannot read token file:", err)
		return 1
	}
	var cfg struct{ URL, Token string }
	if json.Unmarshal(b, &cfg) != nil || cfg.URL == "" || cfg.Token == "" {
		fmt.Fprintln(errOut, "nomi computer mcp: bad token file")
		return 1
	}
	// 用户确认最长等 120 秒，再加执行时间
	client := &http.Client{Timeout: 10 * time.Minute}
	var wmu sync.Mutex
	write := func(p []byte) {
		wmu.Lock()
		defer wmu.Unlock()
		_, _ = out.Write(append(bytes.TrimRight(p, "\r\n"), '\n'))
	}
	sc := bufio.NewScanner(in)
	sc.Buffer(make([]byte, 64*1024), 16<<20)
	var wg sync.WaitGroup
	for sc.Scan() {
		line := append([]byte(nil), bytes.TrimSpace(sc.Bytes())...)
		if len(line) == 0 {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			var head struct {
				ID json.RawMessage `json:"id"`
			}
			_ = json.Unmarshal(line, &head)
			fail := func(msg string) {
				if len(head.ID) == 0 || string(head.ID) == "null" {
					return
				}
				e, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": head.ID,
					"error": map[string]any{"code": -32603, "message": msg}})
				write(e)
			}
			req, err := http.NewRequest(http.MethodPost, cfg.URL, bytes.NewReader(line))
			if err != nil {
				fail(err.Error())
				return
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Accept", "application/json")
			req.Header.Set("Authorization", "Bearer "+cfg.Token)
			resp, err := client.Do(req)
			if err != nil {
				fail("Nomi 没有在运行，或者桌面操作服务不可用：" + err.Error())
				return
			}
			defer resp.Body.Close()
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
			if resp.StatusCode == http.StatusAccepted || len(bytes.TrimSpace(body)) == 0 {
				return
			}
			if resp.StatusCode != http.StatusOK {
				fail(fmt.Sprintf("Nomi 拒绝了请求（HTTP %d）：重启这个编程助手会话后再试", resp.StatusCode))
				return
			}
			write(body)
		}()
	}
	wg.Wait()
	return 0
}
