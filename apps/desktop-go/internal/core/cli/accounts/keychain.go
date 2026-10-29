package accounts

import (
	"context"
	"errors"
	"os/exec"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// KeychainAdapter = keychain.ts KeychainAdapter (get / set always reject: S7).
type KeychainAdapter interface {
	Get(service, account string) *jsrt.Promise[*string]
	Set(service, account, value string) *jsrt.Promise[struct{}]
	Remove(service, account string) *jsrt.Promise[struct{}]
}

func deadOp(op string) error {
	return errors.New("keychain." + op + " removed (S7: Nomi must not read/write credentials)")
}

type macKeychainT struct{}

// MacKeychain = macKeychain.
var MacKeychain KeychainAdapter = macKeychainT{}

func (macKeychainT) Get(string, string) *jsrt.Promise[*string] {
	return jsrt.Rejected[*string](deadOp("get"))
}

func (macKeychainT) Set(string, string, string) *jsrt.Promise[struct{}] {
	return jsrt.Rejected[struct{}](deadOp("set"))
}

func (macKeychainT) Remove(service, account string) *jsrt.Promise[struct{}] {
	p := jsrt.NewPromise[struct{}]()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = exec.CommandContext(ctx, "/usr/bin/security", "delete-generic-password", "-s", service, "-a", account).Run()
		p.Resolve(struct{}{})
	}()
	return p
}
