// Package mockllm：没有 API key 时用的本地 OpenAI 兼容流式服务（SSE /v1/chat/completions）。
package mockllm

import (
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"
)

const reply = "你好呀！我是诺米～这句话来自 Go 核心里的本地 mock 服务器，经 openai-go 流式解析，再按 contract 的 ai.chat.stream 一块一块推到对话窗。"

func Start() (baseURL string, err error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fl := w.(http.Flusher)
		id := fmt.Sprintf("mock-%d", time.Now().UnixNano())
		for _, ch := range strings.Split(reply, "") {
			select {
			case <-r.Context().Done():
				return
			case <-time.After(30 * time.Millisecond):
			}
			fmt.Fprintf(w, "data: {\"id\":%q,\"object\":\"chat.completion.chunk\",\"created\":0,\"model\":\"mock\",\"choices\":[{\"index\":0,\"delta\":{\"content\":%q}}]}\n\n", id, ch)
			fl.Flush()
		}
		fmt.Fprintf(w, "data: {\"id\":%q,\"object\":\"chat.completion.chunk\",\"created\":0,\"model\":\"mock\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n", id)
		fmt.Fprintf(w, "data: {\"id\":%q,\"object\":\"chat.completion.chunk\",\"created\":0,\"model\":\"mock\",\"choices\":[],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":%d,\"total_tokens\":%d}}\n\n", id, len([]rune(reply)), 5+len([]rune(reply)))
		fmt.Fprint(w, "data: [DONE]\n\n")
		fl.Flush()
	})
	go http.Serve(ln, mux)
	return "http://" + ln.Addr().String() + "/v1", nil
}
