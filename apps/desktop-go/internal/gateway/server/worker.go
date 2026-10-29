package server

// worker.go is worker.ts (runGatewayWorker): the gateway process message loop.
// The main process (GatewayService) pushes config snapshots through the port; the
// gateway reports its listen address, usage, learning, key status and errors.
// Like Node, the loop does not depend on the host: port only needs OnMessage /
// PostMessage (tests use a fake port; the desktop host uses an in-process port).

import (
	"os"
	"strconv"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/models"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/route"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/upstream"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// WorkerInbound is WorkerInbound: {type:'config'} | {type:'stop'} | BindingMessage.
type WorkerInbound struct {
	Type    string
	Config  *config.GatewayConfig
	Binding *route.BindingMessage
}

// WorkerOutbound is WorkerOutbound.
type WorkerOutbound struct {
	Type      string // listening | usage | learn | key-status | error | stopped | binding:ok | binding:error
	Port      int
	URL       string
	Usage     *u.Obj
	Learn     *LearnEvent
	KeyStatus *upstream.KeyStatusEvent
	Message   string
	Fatal     bool
	Ack       *route.BindingAck
}

// WorkerPort is WorkerPort.
type WorkerPort interface {
	OnMessage(fn func(m WorkerInbound))
	PostMessage(m WorkerOutbound)
}

// RunGatewayWorker is runGatewayWorker(port, hooks): hooks' OnUsage/OnLearn/OnKeyStatus are replaced.
func RunGatewayWorker(port WorkerPort, hooks GatewayHooks) {
	var gw *GatewayServer
	listenKey := ""
	// The binding table follows the gateway process, not one listener.
	bindings := route.NewBindingTable()
	// Serial message handling (the Node promise chain).
	chain := make(chan WorkerInbound, 64)

	catalogKey := ""
	statKey := func(file string) string {
		if file == "" {
			return ""
		}
		st, err := os.Stat(file)
		if err != nil {
			return ""
		}
		return file + ":" + strconv.FormatFloat(float64(st.ModTime().UnixNano())/1e6, 'f', -1, 64)
	}
	loadCatalog := func(file string) {
		key := statKey(file)
		if key == catalogKey {
			return
		}
		catalogKey = key
		if file != "" && key != "" {
			models.SetCatalogOverlay(models.ReadCatalogFile(file))
		} else {
			models.SetCatalogOverlay(nil)
		}
	}

	apply := func(cfg *config.GatewayConfig) {
		loadCatalog(cfg.CatalogFile)
		key := cfg.Host + ":" + strconv.Itoa(cfg.Port)
		if gw != nil && key == listenKey {
			gw.Update(cfg)
			return
		}
		if gw != nil {
			gw.Stop()
		}
		h := hooks
		h.Bindings = bindings
		h.OnUsage = func(e *u.Obj) { port.PostMessage(WorkerOutbound{Type: "usage", Usage: e}) }
		h.OnLearn = func(e LearnEvent) { port.PostMessage(WorkerOutbound{Type: "learn", Learn: &e}) }
		h.OnKeyStatus = func(e upstream.KeyStatusEvent) {
			port.PostMessage(WorkerOutbound{Type: "key-status", KeyStatus: &e})
		}
		gw = CreateGateway(cfg, h)
		if err := gw.Start(); err != nil {
			gw = nil
			listenKey = ""
			// Port in use etc.: the main process prompts and retries.
			port.PostMessage(WorkerOutbound{Type: "error", Message: err.Error(), Fatal: true})
			return
		}
		listenKey = key
		p := cfg.Port
		if a := gw.Address(); a != nil {
			p = a.Port
		}
		port.PostMessage(WorkerOutbound{Type: "listening", Port: p, URL: gw.ListenURL()})
	}

	var done <-chan struct{}
	if d, ok := port.(interface{ Done() <-chan struct{} }); ok {
		done = d.Done() // the in-process "child" was killed (process exit)
	}
	go func() {
		// 进程内「子进程」：循环结束（网关已 Stop、会话已落盘）即「进程退出」
		if f, ok := port.(interface{ Finished() }); ok {
			defer f.Finished()
		}
		for {
			var m WorkerInbound
			select {
			case m = <-chain:
			case <-done:
				if gw != nil {
					gw.Stop()
				}
				return
			}
			switch m.Type {
			case "config":
				apply(m.Config)
			case "stop":
				if gw != nil {
					gw.Stop()
				}
				gw = nil
				listenKey = ""
				port.PostMessage(WorkerOutbound{Type: "stopped"})
			}
		}
	}()

	port.OnMessage(func(m WorkerInbound) {
		// Binding messages are not queued behind configs: answer synchronously.
		if m.Type == "binding:add" || m.Type == "binding:update" || m.Type == "binding:remove" {
			ack := bindings.Handle(*m.Binding)
			port.PostMessage(WorkerOutbound{Type: ack.Type, Ack: &ack})
			return
		}
		select {
		case chain <- m:
		case <-done:
		}
	})
}
