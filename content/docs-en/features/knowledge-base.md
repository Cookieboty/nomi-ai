# Knowledge Base

Entry points: "Settings → Knowledge & Memory → Knowledge Base", or open the same tab in the right drawer via the "Knowledge · Memory · Schedule" icon at the bottom of the sidebar or `Ctrl/⌘+Shift+M`. Toggle "Knowledge base Q&A" from the input bar's "More features" menu or with `Ctrl/⌘+Shift+K`.

## Adding Sources

- Click "Add folder" to choose folders via the system picker; adding a folder grants read-only access to it, and you can remove it at any time.
- Supports txt, Markdown, csv, json, yaml, html, common source code files, PDF (citations include page numbers), docx, odt, rtf, and xlsx.
- Hidden directories, `node_modules`, `dist`, `build`, and files larger than 30 MB are skipped; sensitive directories (such as `.ssh` and browser profiles) are never read.
- Text inside images cannot be indexed yet: the panel includes an OCR toggle ("Recognize text in images (OCR)") and language data download, but OCR is not implemented in this release—enabling it causes image files to fail indexing (without affecting other files).

## Answers with Citations

When "Knowledge base Q&A" is enabled, Nomi retrieves relevant passages first and lets the active model answer based on them in the language of your question. Inline `[1]`, `[2]` markers in the response are clickable citations: preview the passage, open the file, or reveal it in the folder. "Chunks cited per answer" controls how many passages are attached to the model—higher values give broader coverage while using more context.

The "Search test" tab lets you enter a query and inspect which passages are retrieved.

## Retrieval Quality

- Uses fully local keyword search (BM25) by default, which works well for Chinese as well and requires no extra setup.
- Under "Vectors & reranking", you can connect an embedding model (local Ollama `nomic-embed-text` or `bge-m3` recommended) and a reranking service supporting the `/rerank` endpoint to improve relevance further. Select services from providers already configured in "Settings → Models & Agents".
- Before sending file passages to a cloud embedding or reranking service, Nomi asks for separate consent; when "Only local models can read files" is enabled, nothing is ever sent to the cloud.

## Updating the Index

Incremental updates run automatically ~20 seconds after startup and every 30 minutes thereafter. You can also click "Update index" or "Rebuild all" at any time.

## Implementation

- Core: `apps/desktop-go/internal/core/knowledge` (hybrid ranking combining BM25 and optional vectors), file parsing in `internal/core/desktop/parse`; data stored in `userData/knowledge`.
- AI tool `kb_search` provides read-only knowledge base retrieval during chat.
- UI: `packages/ai-chat/src/components/KnowledgePanel`.
