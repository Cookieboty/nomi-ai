package devviews

import (
	"context"
	"errors"
	"net"
	"os"
	"syscall"
	"testing"
)

func TestIsTransientConnErrWindowsReset(t *testing.T) {
	reset := &net.OpError{
		Op:  "read",
		Net: "tcp",
		Err: &os.SyscallError{Syscall: "wsarecv", Err: syscall.Errno(wsaEconnReset)},
	}
	if !isTransientConnErr(reset) {
		t.Fatal("WSAECONNRESET wrapped in OpError/SyscallError should be transient")
	}
	refused := &os.SyscallError{Syscall: "connect", Err: syscall.Errno(wsaEconnRefused)}
	if !isTransientConnErr(refused) {
		t.Fatal("WSAECONNREFUSED should be transient")
	}
	aborted := &net.OpError{
		Op:  "read",
		Err: &os.SyscallError{Syscall: "wsarecv", Err: syscall.Errno(wsaEconnAborted)},
	}
	if !isTransientConnErr(aborted) {
		t.Fatal("WSAECONNABORTED should be transient")
	}
	if !isTransientConnErr(errors.New("wsarecv: An existing connection was forcibly closed by the remote host.")) {
		t.Fatal("Windows reset message should be transient")
	}
	if isTransientConnErr(&net.OpError{Op: "read", Err: context.Canceled}) {
		t.Fatal("canceled read is not transient")
	}
	if isTransientConnErr(context.DeadlineExceeded) {
		t.Fatal("deadline is not transient")
	}
	if isTransientConnErr(&os.SyscallError{Syscall: "wsarecv", Err: syscall.Errno(99999)}) {
		t.Fatal("unrelated errno is not transient")
	}
}
