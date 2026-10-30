package main

import (
	"log"
	"net"
	"net/http"
	"net/http/pprof"
	"os"
)

// pprofEnv：设了 NOMI_PPROF=127.0.0.1:PORT 时在该回环地址提供 /debug/pprof/（排查内存 / CPU，开发与测量用）。
// 只接受回环地址；用独立的 ServeMux，不挂到 http.DefaultServeMux 上
const pprofEnv = "NOMI_PPROF"

func startPprof() {
	addr := os.Getenv(pprofEnv)
	if addr == "" {
		return
	}
	host, _, err := net.SplitHostPort(addr)
	if ip := net.ParseIP(host); err != nil || ip == nil || !ip.IsLoopback() {
		log.Printf("[pprof] %s=%q ignored: must be 127.0.0.1:<port>", pprofEnv, addr)
		return
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	go func() {
		log.Printf("[pprof] http://%s/debug/pprof/", addr)
		if err := http.ListenAndServe(addr, mux); err != nil {
			log.Printf("[pprof] %v", err)
		}
	}()
}
