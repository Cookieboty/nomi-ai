package cli

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/chatassets"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// MessageImageStore is shared by history imports and live adapters. Content hashes
// make repeated imports stable across polls/restarts without retaining base64 in messages.
type MessageImageStore struct {
	ChatRoot string
	DirOK    func(string) bool
	Cwd      string
}

var storedImageRef = regexp.MustCompile(`^chat-asset://images/([A-Za-z0-9._-]+)$`)
var imageMarkdownRef = regexp.MustCompile(`!\[[^\]\r\n]*\]\(([^\r\n)]+)\)`)

func (s MessageImageStore) importImage(src, origin string) (string, int, int, error) {
	if m := storedImageRef.FindStringSubmatch(src); m != nil {
		path := filepath.Join(s.ChatRoot, "images", m[1])
		st, err := os.Lstat(path)
		if err != nil || !st.Mode().IsRegular() {
			return "", 0, 0, errors.New("missing image")
		}
		return src, 0, 0, nil
	}
	if strings.HasPrefix(src, "https://") || strings.HasPrefix(src, "http://") {
		u, err := url.Parse(src)
		if err != nil || u.Host == "" || u.User != nil {
			return "", 0, 0, errors.New("invalid image URL")
		}
		// Do not perform an unguarded outbound request while importing a transcript.
		return src, 0, 0, nil
	}
	var data []byte
	if strings.HasPrefix(src, "data:image/") {
		comma := strings.IndexByte(src, ',')
		if comma < 0 || !strings.HasSuffix(src[:comma], ";base64") || len(src) > clisdk.MaxImageReferenceBytes {
			return "", 0, 0, errors.New("invalid image data")
		}
		var err error
		data, err = base64.StdEncoding.DecodeString(src[comma+1:])
		if err != nil {
			return "", 0, 0, err
		}
	} else {
		// LocalImage resolves symlinks, enforces approved directories and temp roots,
		// bounds the read and confirms the file is an image by its bytes.
		if !filepath.IsAbs(src) && !strings.HasPrefix(src, "~/") && !strings.HasPrefix(src, "file://") && s.Cwd != "" {
			src = filepath.Join(s.Cwd, src)
		}
		local, err := chatassets.LocalImage(src, s.DirOK)
		if err != nil {
			return "", 0, 0, err
		}
		return s.importImage(local, origin)
	}
	if len(data) == 0 || len(data) > chatassets.ImportMaxBytes {
		return "", 0, 0, errors.New("image too large")
	}
	mime := http.DetectContentType(data)
	ext := map[string]string{"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp"}[mime]
	if ext == "" {
		return "", 0, 0, errors.New("unsupported image")
	}
	width, height := 0, 0
	if config, _, err := image.DecodeConfig(bytes.NewReader(data)); err == nil {
		width, height = config.Width, config.Height
	}
	prefix := "user"
	if origin != "user" {
		prefix = origin
		if chatassets.SourceOf(prefix+"-test.png") == "" {
			prefix = "gen"
		}
	}
	digest := sha256.Sum256(data)
	name := prefix + "-cli-" + hex.EncodeToString(digest[:]) + "." + ext
	dir := filepath.Join(s.ChatRoot, "images")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", 0, 0, err
	}
	path := filepath.Join(dir, name)
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if os.IsExist(err) {
		st, e := os.Lstat(path)
		if e != nil || !st.Mode().IsRegular() || st.Size() != int64(len(data)) {
			return "", 0, 0, errors.New("invalid cached image")
		}
	} else if err != nil {
		return "", 0, 0, err
	} else {
		_, err = file.Write(data)
		closeErr := file.Close()
		if err != nil || closeErr != nil {
			_ = os.Remove(path)
			if err == nil {
				err = closeErr
			}
			return "", 0, 0, err
		}
	}
	return "chat-asset://images/" + name, width, height, nil
}

func (s MessageImageStore) Images(refs []any, origin string) []any {
	out := []any{}
	seen := map[string]bool{}
	for _, raw := range refs {
		ref := util.AsObj(raw)
		if ref == nil || len(out) >= clisdk.MaxMessageImages {
			continue
		}
		src := util.Str(ref.Get("ref"))
		if src == "" {
			out = append(out, raw)
			continue
		} // Existing normalized thumbnails stay intact.
		link, w, h, err := s.importImage(src, origin)
		if err != nil {
			if fallback := util.Str(ref.Get("fallback")); fallback != "" {
				link, w, h, err = s.importImage(fallback, origin)
			}
		}
		name := util.Str(ref.Get("name"))
		if name == "" {
			if !strings.HasPrefix(src, "data:") {
				name = filepath.Base(strings.ReplaceAll(src, "\\", "/"))
			} else {
				name = "image"
			}
		}
		if err != nil {
			if seen[src] {
				continue
			}
			seen[src] = true
			failed := util.NewObj("thumb", "", "width", float64(0), "height", float64(0), "name", name, "unavailable", true)
			if !strings.HasPrefix(src, "data:") {
				failed.Set("path", src)
			}
			out = append(out, failed)
			continue
		}
		if seen[link] {
			continue
		}
		seen[link] = true
		out = append(out, util.NewObj("thumb", link, "width", float64(w), "height", float64(h), "url", link, "source", "cli", "name", name))
	}
	return out
}

func (s MessageImageStore) Markdown(text, origin string) string {
	return rewriteImageProse(text, func(prose string) string {
		return imageMarkdownRef.ReplaceAllStringFunc(prose, func(mark string) string {
			m := imageMarkdownRef.FindStringSubmatch(mark)
			src := m[1]
			if !strings.HasPrefix(src, "data:") && !strings.HasPrefix(src, "file:") {
				if decoded, err := url.PathUnescape(src); err == nil {
					src = decoded
				}
			}
			link, _, _, err := s.importImage(src, origin)
			if err != nil {
				return mark
			}
			return strings.Replace(mark, m[1], link, 1)
		})
	})
}

// Messages normalizes images in place and reports whether any message changed,
// so callers can skip rewriting an unchanged transcript to disk.
func (s MessageImageStore) Messages(messages []*util.Obj, backend string) bool {
	changed := false
	for _, msg := range messages {
		if msg == nil {
			continue
		}
		if msg.Get("role") == "user" {
			if refs, ok := msg.Get("images").([]any); !ok || len(refs) == 0 {
				text, refs := clisdk.RestoreUserImages(util.Str(msg.Get("content")), nil)
				if len(refs) > 0 {
					msg.Set("content", text)
					msg.Set("images", refs)
					changed = true
				}
			}
		}

		if refs, ok := msg.Get("images").([]any); ok && imagesNeedNormalizing(refs) {
			msg.Set("images", s.Images(refs, "user"))
			changed = true
		}
		if msg.Get("role") == "assistant" {
			old := util.Str(msg.Get("content"))
			if text := s.Markdown(old, backend); text != old {
				msg.Set("content", text)
				changed = true
			}
		}
	}
	return changed
}

// imagesNeedNormalizing: Images leaves already-normalized entries as they are, so only
// raw references (a "ref" to import), empty slots or an over-long list change anything.
func imagesNeedNormalizing(refs []any) bool {
	if len(refs) > clisdk.MaxMessageImages {
		return true
	}
	for _, raw := range refs {
		ref := util.AsObj(raw)
		if ref == nil || util.Str(ref.Get("ref")) != "" {
			return true
		}
	}
	return false
}

// Leave fenced/inline code samples untouched when persisting rendered images.
func rewriteImageProse(text string, rewrite func(string) string) string {
	var out strings.Builder
	fence, fenceSize := byte(0), 0
	for _, line := range strings.SplitAfter(text, "\n") {
		trimmed := strings.TrimLeft(line, " ")
		indent := len(line) - len(trimmed)
		marker, count := byte(0), 0
		if len(trimmed) > 0 && (trimmed[0] == '`' || trimmed[0] == '~') {
			marker = trimmed[0]
			for count < len(trimmed) && trimmed[count] == marker {
				count++
			}
		}
		if fence != 0 {
			out.WriteString(line)
			if indent <= 3 && marker == fence && count >= fenceSize && strings.TrimSpace(trimmed[count:]) == "" {
				fence = 0
			}
			continue
		}
		if indent <= 3 && count >= 3 {
			fence, fenceSize = marker, count
			out.WriteString(line)
			continue
		}
		if indent >= 4 {
			out.WriteString(line)
			continue
		}
		for len(line) > 0 {
			start := strings.IndexByte(line, '`')
			if start < 0 {
				out.WriteString(rewrite(line))
				break
			}
			run := 1
			for start+run < len(line) && line[start+run] == '`' {
				run++
			}
			end := start + run
			closeAt := -1
			for end < len(line) {
				n := strings.IndexByte(line[end:], '`')
				if n < 0 {
					break
				}
				end += n
				size := 1
				for end+size < len(line) && line[end+size] == '`' {
					size++
				}
				if size == run {
					closeAt = end + size
					break
				}
				end += size
			}
			if closeAt < 0 {
				out.WriteString(rewrite(line))
				break
			}
			out.WriteString(rewrite(line[:start]))
			out.WriteString(line[start:closeAt])
			line = line[closeAt:]
		}
	}
	return out.String()
}
