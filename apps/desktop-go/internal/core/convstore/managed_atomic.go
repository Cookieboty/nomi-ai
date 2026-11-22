package convstore

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
)

var ErrDurabilityUnsupported = errors.New("managed authority durability is not implemented on this platform")

// UncertainCommit means rename happened but directory durability was not
// confirmed. The caller MUST reopen; retrying a user operation is unsafe.
type UncertainCommit struct{ Err error }

func (e *UncertainCommit) Error() string {
	return "managed commit publication uncertain: " + e.Err.Error()
}
func (e *UncertainCommit) Unwrap() error { return e.Err }

type managedIO struct {
	Point  func(string) error
	Write  func(*os.File, []byte) (int, error)
	Rename func(string, string) error
}

func defaultManagedIO() managedIO {
	return managedIO{Write: func(f *os.File, b []byte) (int, error) { return f.Write(b) }, Rename: os.Rename}
}
func (ops managedIO) point(stage string) error {
	if ops.Point != nil {
		return ops.Point(stage)
	}
	return nil
}
func ManagedSupported() bool { return runtime.GOOS != "windows" }
func syncDirectory(path string) error {
	// Do not claim Unix fsync semantics on Windows. No production cutover there
	// until a tested durable replacement primitive is implemented.
	if runtime.GOOS == "windows" {
		return ErrDurabilityUnsupported
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}
func atomicManaged(path string, data []byte, ops managedIO) (err error) {
	if runtime.GOOS == "windows" {
		return ErrDurabilityUnsupported
	}
	if len(data) > maxManagedBytes {
		return fmt.Errorf("%w: managed checkpoint exceeds %d bytes", ErrMigrationBlocked, maxManagedBytes)
	}
	dir := filepath.Dir(path)
	if err = ops.point("mkdir"); err != nil {
		return err
	}
	if err = os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	if err = ops.point("parent-sync"); err != nil {
		return err
	}
	if err = syncDirectory(filepath.Dir(dir)); err != nil {
		return err
	}
	if err = ops.point("ancestor-sync"); err != nil {
		return err
	}
	if err = syncDirectory(filepath.Dir(filepath.Dir(dir))); err != nil {
		return err
	}
	if err = ops.point("create"); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".managed-tmp-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer func() { _ = f.Close(); _ = os.Remove(tmp) }()
	if err = ops.point("chmod"); err != nil {
		return err
	}
	if err = f.Chmod(0600); err != nil {
		return err
	}
	if err = ops.point("write"); err != nil {
		return err
	}
	n, err := ops.Write(f, data)
	if err != nil {
		return err
	}
	if n != len(data) {
		return io.ErrShortWrite
	}
	if err = ops.point("file-sync"); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = ops.point("close"); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = ops.point("rename"); err != nil {
		return err
	}
	if err = ops.Rename(tmp, path); err != nil {
		return err
	}
	if err = ops.point("after-rename"); err != nil {
		return &UncertainCommit{err}
	}
	if err = ops.point("directory-sync"); err != nil {
		return &UncertainCommit{err}
	}
	if err = syncDirectory(dir); err != nil {
		return &UncertainCommit{fmt.Errorf("directory sync: %w", err)}
	}
	return nil
}
