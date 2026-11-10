package harness

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/resourcepreview"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

func (o *Orchestrator) AttachPreview(s *resourcepreview.Service) { o.preview = s }
func (o *Orchestrator) PreviewOpen(cwd, path string, allowOutside bool) *jsrt.Promise[resourcepreview.Result] {
	if o.preview == nil {
		return jsrt.Resolved(resourcepreview.Result{Code: "unavailable"})
	}
	root := ""
	if cwd != "" {
		root = o.KnownDir(cwd)
	}
	home, s := o.home, o.preview
	return ioAsync(func() resourcepreview.Result { return s.Open(root, path, home, allowOutside) })
}
func (o *Orchestrator) PreviewClose(url string) bool {
	if o.preview != nil {
		o.preview.Close(url)
	}
	return true
}
func (o *Orchestrator) PreviewWeb(url string) *jsrt.Promise[resourcepreview.Result] {
	s := o.preview
	return ioAsync(func() resourcepreview.Result {
		if s == nil {
			return resourcepreview.Result{Code: "unavailable"}
		}
		return s.Web(url)
	})
}

func (o *Orchestrator) PreviewExternal(cwd, path string, allowOutside bool) *jsrt.Promise[resourcepreview.Result] {
	if o.preview == nil {
		return jsrt.Resolved(resourcepreview.Result{Code: "unavailable"})
	}
	root := ""
	if cwd != "" {
		root = o.KnownDir(cwd)
	}
	home, s := o.home, o.preview
	return ioAsync(func() resourcepreview.Result { return s.External(root, path, home, allowOutside) })
}

func (o *Orchestrator) PreviewSave(url, revision, content string) *jsrt.Promise[resourcepreview.SaveResult] {
	s := o.preview
	return ioAsync(func() resourcepreview.SaveResult {
		if s == nil {
			return resourcepreview.SaveResult{Code: "unavailable"}
		}
		return s.Save(url, revision, content)
	})
}

// PreviewListDirectory only delegates preview-local filename browsing; no session cwd changes.
func (o *Orchestrator) PreviewListDirectory(url, path string) *jsrt.Promise[resourcepreview.DirectoryResult] {
	s := o.preview
	return ioAsync(func() resourcepreview.DirectoryResult {
		if s == nil {
			return resourcepreview.DirectoryResult{Code: "unavailable"}
		}
		return s.ListDirectory(url, path)
	})
}
