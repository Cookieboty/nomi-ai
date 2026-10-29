package knowledge

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
)

// Downloader：voice/download.downloadVerified 的最小移植（流式写 .part → sha256 校验 → 原子改名）。
// TODO(batch-voice): 换成共享的下载实现（断点续传、空闲超时）。
type Downloader func(ctx context.Context, url, sha string, dest string, expected int64, onProgress func(received, total int64)) error

func DownloadVerified(ctx context.Context, url, sha string, dest string, expected int64, onProgress func(received, total int64)) error {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return fmt.Errorf("HTTP %d", res.StatusCode)
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	tmp := dest + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	h := sha256.New()
	total := res.ContentLength
	if total <= 0 {
		total = expected
	}
	var got int64
	buf := make([]byte, 64<<10)
	for {
		n, rerr := res.Body.Read(buf)
		if n > 0 {
			if _, err := f.Write(buf[:n]); err != nil {
				f.Close()
				os.Remove(tmp)
				return err
			}
			h.Write(buf[:n])
			got += int64(n)
			if onProgress != nil {
				onProgress(got, total)
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			f.Close()
			os.Remove(tmp)
			return rerr
		}
	}
	f.Close()
	if hex.EncodeToString(h.Sum(nil)) != sha {
		os.Remove(tmp)
		return fmt.Errorf("checksum mismatch")
	}
	return os.Rename(tmp, dest)
}
