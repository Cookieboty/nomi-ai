package local

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// ExtractZip / ExtractTarGz：voice/download 的 extractZip / extractTarGz（拒绝越界路径）。
// TODO(batch-voice): 换成共享实现。
func safe(root, name string) (string, error) {
	p := filepath.Join(root, name)
	if p != filepath.Clean(root) && !strings.HasPrefix(p, filepath.Clean(root)+string(os.PathSeparator)) {
		return "", errors.New("unsafe path in archive: " + name)
	}
	return p, nil
}

func ExtractZip(buf []byte, dest string) error {
	zr, err := zip.NewReader(bytes.NewReader(buf), int64(len(buf)))
	if err != nil {
		return err
	}
	for _, f := range zr.File {
		p, err := safe(dest, f.Name)
		if err != nil {
			return err
		}
		if f.FileInfo().IsDir() {
			_ = os.MkdirAll(p, 0o755)
			continue
		}
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		rc, err := f.Open()
		if err != nil {
			return err
		}
		b, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			return err
		}
		if err := os.WriteFile(p, b, f.Mode().Perm()|0o600); err != nil {
			return err
		}
	}
	return nil
}

func ExtractTarGz(buf []byte, dest string) error {
	gz, err := gzip.NewReader(bytes.NewReader(buf))
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		p, err := safe(dest, h.Name)
		if err != nil {
			return err
		}
		switch h.Typeflag {
		case tar.TypeDir:
			_ = os.MkdirAll(p, 0o755)
		case tar.TypeReg:
			_ = os.MkdirAll(filepath.Dir(p), 0o755)
			b, err := io.ReadAll(tr)
			if err != nil {
				return err
			}
			if err := os.WriteFile(p, b, os.FileMode(h.Mode).Perm()|0o600); err != nil {
				return err
			}
		case tar.TypeSymlink:
			_ = os.MkdirAll(filepath.Dir(p), 0o755)
			_ = os.Symlink(h.Linkname, p)
		}
	}
}
