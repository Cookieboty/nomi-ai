package convstore

import (
	"errors"
	"os"
	"path/filepath"
)

var ErrWriterBusy = errors.New("conversation store writer is busy")
var ErrManaged = errors.New("conversation is managed by the kernel runtime; legacy writes forbidden")

func lockPath(path string) (func(), error) { return lockPathMode(path, false) }
func lockPathMode(path string, wait bool) (func(), error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = lockFile(f, wait); err != nil {
		f.Close()
		return nil, err
	}
	return func() { _ = unlockFile(f); _ = f.Close() }, nil
}

// Existing v1 APIs and v2 commits share the same short OS operation lock.
// A separate per-conversation lease prevents two live runtime authorities.
func (s *Store) lockStore() (func(), error) {
	s.mu.Lock()
	unlock, err := lockPathMode(filepath.Join(s.dir, ".writer.lock"), true)
	if err != nil {
		s.mu.Unlock()
		return nil, err
	}
	s.loaded = false // Other Store instances share the OS lock, not this cache.
	return func() { unlock(); s.mu.Unlock() }, nil
}
func (s *Store) legacyWritable(id string) error {
	_, err := os.Lstat(s.managedPath(id))
	if err == nil {
		return ErrManaged
	}
	if os.IsNotExist(err) {
		return nil
	}
	return err
}
