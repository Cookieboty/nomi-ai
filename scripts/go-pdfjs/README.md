# go-pdfjs

Helpers for the Go port of pdf.js text extraction (`apps/desktop-go/internal/core/desktop/parse/pdfjs_*.go`).

- `gentables.mjs` — run in a directory containing pdf.js v6.1.200 `src/core/{metrics,encodings,standard_fonts,glyphlist,bidi}.js`; prints `pdfjs_tables_gen.go`.
- `genfixtures.mjs` / `genfixtures2.mjs` — write fixture PDFs into `pdfs/` / `pdfs2/`.
- `expected.mjs` — runs unpdf `extractText` (mergePages:false) over `pdfs/` and prints the JSON stored as `testdata/pdf/expected.json` (Node trims each page).
