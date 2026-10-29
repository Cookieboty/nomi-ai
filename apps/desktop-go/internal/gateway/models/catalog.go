package models

import (
	_ "embed"
	"os"
	"regexp"
	"strings"
	"sync"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

//go:embed catalog.json
var catalogJSON []byte

// CatalogDoc is CatalogDoc.
type CatalogDoc struct {
	Version string
	Source  string
	License string
	Models  *u.Obj
}

// JSON is the doc as an object ({ version, source, license, models }).
func (d *CatalogDoc) JSON() *u.Obj {
	return u.NewObj("version", d.Version, "source", d.Source, "license", d.License, "models", d.Models)
}

var doc *CatalogDoc

// CatalogVersion is CATALOG_VERSION.
var CatalogVersion string

func init() {
	v, err := u.Parse(catalogJSON)
	if err != nil {
		panic(err)
	}
	o := v.(*u.Obj)
	doc = &CatalogDoc{Version: u.Str(o.Get("version")), Source: u.Str(o.Get("source")), License: u.Str(o.Get("license")), Models: o.Get("models").(*u.Obj)}
	CatalogVersion = doc.Version
}

var (
	overlayMu sync.RWMutex
	overlay   *CatalogDoc
)

// SetCatalogOverlay is setCatalogOverlay (nil clears).
func SetCatalogOverlay(next *CatalogDoc) {
	overlayMu.Lock()
	defer overlayMu.Unlock()
	if next != nil && next.Models != nil {
		overlay = next
	} else {
		overlay = nil
	}
}

func currentOverlay() *CatalogDoc {
	overlayMu.RLock()
	defer overlayMu.RUnlock()
	return overlay
}

const (
	maxOverlayBytes  = 16 * 1024 * 1024
	minOverlayModels = 50
)

// ReadCatalogFile is readCatalogFile (nil = unusable).
func ReadCatalogFile(file string) *CatalogDoc {
	st, err := os.Stat(file)
	if err != nil || st.Size() > maxOverlayBytes {
		return nil
	}
	b, err := os.ReadFile(file)
	if err != nil {
		return nil
	}
	v, err := u.Parse(b)
	if err != nil {
		return nil
	}
	j, _ := v.(*u.Obj)
	if j == nil {
		return nil
	}
	models, ok := j.Get("models").(*u.Obj)
	if !ok || models == nil || models.Len() < minOverlayModels {
		return nil
	}
	ver, _ := j.Get("version").(string)
	return &CatalogDoc{Version: ver, Source: "models.dev", License: "MIT", Models: models}
}

// CatalogOverlayVersion is catalogOverlayVersion (nil = no overlay).
func CatalogOverlayVersion() *string {
	if o := currentOverlay(); o != nil {
		return u.Ptr(o.Version)
	}
	return nil
}

// BareModelID is bareModelId.
func BareModelID(id string) string {
	if i := strings.LastIndex(id, "/"); i >= 0 {
		id = id[i+1:]
	}
	return u.JSLower(id)
}

var (
	tagRe  = regexp.MustCompile(`:[\w.-]+$`)
	dateRe = regexp.MustCompile(`-\d{8}$|-latest$`)
)

// protoKeys are the names a plain JS object inherits from Object.prototype:
// `models[id]` finds them even though the catalog does not list them.
var protoKeys = map[string]bool{
	"constructor": true, "__proto__": true, "hasOwnProperty": true, "isPrototypeOf": true,
	"propertyIsEnumerable": true, "toString": true, "toLocaleString": true, "valueOf": true,
	"__defineGetter__": true, "__defineSetter__": true, "__lookupGetter__": true, "__lookupSetter__": true,
}

// IsProtoKey reports whether obj[k] on a plain JS object hits Object.prototype.
func IsProtoKey(k string) bool { return protoKeys[k] }

func lookup(m *u.Obj, k string) *u.Obj {
	if m == nil {
		return nil
	}
	if m.Has(k) {
		if o, ok := m.Get(k).(*u.Obj); ok && o != nil {
			return o
		}
		if u.Truthy(m.Get(k)) {
			return u.NewObj()
		}
		return nil
	}
	if protoKeys[k] {
		return u.NewObj() // an inherited function: truthy, no own keys
	}
	return nil
}

// CatalogEntry is catalogEntry (nil = not listed).
func CatalogEntry(model string) *u.Obj {
	id := tagRe.ReplaceAllString(BareModelID(model), "")
	base := dateRe.ReplaceAllString(id, "")
	ov := currentOverlay()
	var om *u.Obj
	if ov != nil {
		om = ov.Models
	}
	for _, x := range []*u.Obj{lookup(om, id), lookup(doc.Models, id), lookup(om, base), lookup(doc.Models, base)} {
		if x != nil {
			return x
		}
	}
	return nil
}

// CatalogSize is catalogSize.
func CatalogSize() int {
	seen := map[string]bool{}
	for _, k := range doc.Models.Keys() {
		seen[k] = true
	}
	if ov := currentOverlay(); ov != nil {
		for _, k := range ov.Models.Keys() {
			seen[k] = true
		}
	}
	return len(seen)
}
