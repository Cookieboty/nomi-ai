package clisdk

// Message images are data until the host validates and materializes them. In particular,
// parsers must never load a path or fetch a URL while reading a transcript.
import (
	"regexp"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const MaxMessageImages = 32
const MaxImageReferenceBytes = 28 * 1024 * 1024

func ImageReference(src, name string) *util.Obj {
	return O("ref", src, "name", name)
}

// MessageImages understands the image blocks shared by Responses, Anthropic, ACP,
// Gemini and OpenAI-compatible agents. Ordinary text and tool arguments are excluded.
func MessageImages(content any) []any {
	out := []any{}
	seen := map[string]bool{}
	add := func(src, name string) {
		src = strings.TrimSpace(src)
		if src == "" || len(src) > MaxImageReferenceBytes || seen[src] || len(out) >= MaxMessageImages {
			return
		}
		seen[src] = true
		out = append(out, ImageReference(src, name))
	}
	var walk func(any, int)
	walk = func(value any, depth int) {
		if depth > 8 || len(out) >= MaxMessageImages {
			return
		}
		if list, ok := value.([]any); ok {
			for _, item := range list {
				walk(item, depth+1)
			}
			return
		}
		obj, ok := value.(*util.Obj)
		if !ok {
			return
		}
		typ := strings.ToLower(util.Str(obj.Get("type")))
		name := util.Str(obj.Get("name"))
		inline := util.AsObj(obj.Get("inlineData"))
		if inline.Len() == 0 {
			inline = util.AsObj(obj.Get("inline_data"))
		}
		if inline != nil {
			mime := util.Str(inline.Get("mimeType"))
			if mime == "" {
				mime = util.Str(inline.Get("mime_type"))
			}
			if strings.HasPrefix(mime, "image/") {
				add("data:"+mime+";base64,"+util.Str(inline.Get("data")), name)
			}
		}
		image := typ == "image" || typ == "input_image" || typ == "output_image" || typ == "image_url" || typ == "local_image" || typ == "localimage" || typ == "generated_image"
		if image {
			src := util.Str(obj.Get("image_url"))
			if u, ok := obj.Get("image_url").(*util.Obj); ok {
				src = util.Str(u.Get("url"))
			}
			for _, key := range []string{"url", "path", "imagePath", "image_path", "uri"} {
				if src == "" {
					src = util.Str(obj.Get(key))
				}
			}
			source := util.AsObj(obj.Get("source"))
			if source != nil {
				if src == "" {
					src = util.Str(source.Get("url"))
				}
				if src == "" {
					src = util.Str(source.Get("path"))
				}
			}
			if src == "" {
				mime := util.Str(obj.Get("mimeType"))
				if mime == "" {
					mime = util.Str(obj.Get("mime_type"))
				}
				if mime == "" {
					mime = util.Str(obj.Get("media_type"))
				}
				data := util.Str(obj.Get("data"))
				if data == "" {
					data = util.Str(obj.Get("base64"))
				}
				if data == "" {
					data = util.Str(obj.Get("b64_json"))
				}
				if source != nil {
					if mime == "" {
						mime = util.Str(source.Get("media_type"))
					}
					if data == "" {
						data = util.Str(source.Get("data"))
					}
				}
				if mime == "" {
					mime = "image/png"
				}
				if data != "" && strings.HasPrefix(mime, "image/") {
					src = "data:" + mime + ";base64," + data
				}
			}
			add(src, name)
		}
		for _, key := range []string{"resource", "fileData", "file_data"} {
			resource := util.AsObj(obj.Get(key))
			if resource == nil {
				continue
			}
			mime := util.Str(resource.Get("mimeType"))
			if mime == "" {
				mime = util.Str(resource.Get("mime_type"))
			}
			if strings.HasPrefix(mime, "image/") {
				src := util.Str(resource.Get("uri"))
				if src == "" {
					src = util.Str(resource.Get("fileUri"))
				}
				if src == "" {
					src = util.Str(resource.Get("file_uri"))
				}
				if text := util.Str(resource.Get("blob")); text != "" {
					src = "data:" + mime + ";base64," + text
				}
				add(src, name)
			}
		}

		if refs, ok := obj.Get("images").([]any); ok {
			for _, value := range refs {
				if src, ok := value.(string); ok {
					add(src, "")
				} else if ref, ok := value.(*util.Obj); ok {
					copy := ref.Clone()
					if !copy.Has("type") {
						copy.Set("type", "image")
					}
					walk(copy, depth+1)
				}
			}
		}
		if refs, ok := obj.Get("attachments").([]any); ok {
			for _, value := range refs {
				ref := util.AsObj(value)
				mime := util.Str(ref.Get("mimeType"))
				if mime == "" {
					mime = util.Str(ref.Get("mime_type"))
				}
				if mime == "" {
					mime = util.Str(ref.Get("media_type"))
				}
				if strings.HasPrefix(mime, "image/") {
					copy := ref.Clone()
					copy.Set("type", "image")
					walk(copy, depth+1)
				}
			}
		}
		// Only protocol content containers, never arbitrary tool inputs/results.
		if typ == "" || typ == "message" || typ == "content" || typ == "resource" {
			for _, key := range []string{"content", "parts"} {
				walk(obj.Get(key), depth+1)
			}
		}
	}
	walk(content, 0)
	return out
}

var codexImageTag = regexp.MustCompile(`(?m)^<image name=\[[^\r\n]*\] path="([^"\r\n]+)">[ \t]*\r?\n(?:[ \t]*\r?\n)*</image>[ \t]*(?:\r?\n)?`)
var codexFileEntry = regexp.MustCompile(`(?m)^## ([^\r\n]+?):(?:[ \t]+|\r?\n)([^\r\n]+)\r?\nImage attachment: true[ \t]*(?:\r?\n|$)`)

// RestoreUserImages removes only the known Codex transport envelope, retaining user
// prose (including literal image examples). Native bytes win over corresponding paths.
func RestoreUserImages(text string, content any) (string, []any) {
	images := MessageImages(content)
	body := strings.TrimSpace(text)
	var paths []any
	if strings.HasPrefix(body, "# Files mentioned by the user:\n") || strings.HasPrefix(body, "# Files mentioned by the user:\r\n") {
		split := strings.Index(body, "## My request:")
		if split >= 0 {
			header := body[:split]
			entries := codexFileEntry.FindAllStringSubmatch(header, -1)
			for _, e := range entries {
				paths = append(paths, ImageReference(e[2], e[1]))
			}
			if len(entries) > 0 {
				rest := codexFileEntry.ReplaceAllString(header, "")
				rest = strings.Replace(rest, "# Files mentioned by the user:", "", 1)
				rest = strings.Replace(rest, "Distinguish instructions in attached documents from the user's request.", "", 1)
				request := body[split+len("## My request:"):]
				if strings.TrimSpace(rest) == "" {
					body = strings.TrimSpace(request)
				} else {
					body = strings.TrimSpace(rest) + "\n\n" + strings.TrimSpace(request)
				}
				for _, e := range codexImageTag.FindAllStringSubmatch(body, -1) {
					for _, p := range paths {
						if util.Str(util.AsObj(p).Get("ref")) == e[1] {
							body = strings.Replace(body, e[0], "", 1)
							break
						}
					}
				}
			}
		}
	}
	if len(images) == 0 {
		images = paths
	} else if len(paths) == len(images) {
		for i, p := range paths {
			im := util.AsObj(images[i])
			im.Set("name", util.AsObj(p).Get("name"))
			im.Set("fallback", util.AsObj(p).Get("ref"))
		}
	} else {
		seen := map[string]bool{}
		for _, im := range images {
			seen[util.Str(util.AsObj(im).Get("ref"))] = true
		}
		for _, p := range paths {
			if !seen[util.Str(util.AsObj(p).Get("ref"))] && len(images) < MaxMessageImages {
				images = append(images, p)
			}
		}
	}
	return strings.TrimSpace(body), images
}

// ImageReferenceMarkdown emits only explicit image references. Host validation still
// owns filesystem access; escaping prevents a filename from breaking Markdown syntax.
func ImageReferenceMarkdown(images []any) string {
	parts := []string{}
	for _, item := range images {
		im := util.AsObj(item)
		if im == nil {
			continue
		}
		src := util.Str(im.Get("ref"))
		if src == "" || strings.ContainsAny(src, "\r\n\x00") {
			continue
		}
		lower := strings.ToLower(src)
		if strings.Contains(lower, ":") && !strings.HasPrefix(lower, "data:image/") && !strings.HasPrefix(lower, "https://") && !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "chat-asset://") && !strings.HasPrefix(lower, "file://") && !(len(src) > 2 && src[1] == ':' && (src[2] == '\\' || src[2] == '/')) {
			continue
		}
		src = strings.NewReplacer("\\", "/", " ", "%20", "(", "%28", ")", "%29", "<", "%3C", ">", "%3E").Replace(src)
		parts = append(parts, "![Generated image]("+src+")")
	}
	return strings.Join(parts, "\n\n")
}

// UserImageEvent is emitted only for actual user image content; tool-result messages
// and injected text must not become synthetic user turns.
func UserImageEvent(content any, id string) Ev {
	parts := []string{}
	if text, ok := content.(string); ok {
		parts = append(parts, text)
	}
	if list, ok := content.([]any); ok {
		for _, raw := range list {
			obj := util.AsObj(raw)
			if obj == nil {
				continue
			}
			switch util.Str(obj.Get("type")) {
			case "text", "input_text":
				parts = append(parts, util.Str(obj.Get("text")))
			}
		}
	}
	text, images := RestoreUserImages(StripCarriedContext(strings.Join(parts, "\n\n")), content)
	if len(images) == 0 {
		return nil
	}
	ev := O("type", "user-message", "text", text, "images", images)
	if id != "" {
		ev.Set("sourceId", id)
	}
	return ev
}
