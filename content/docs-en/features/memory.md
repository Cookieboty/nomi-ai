# Long-Term Memory

Entry points: "Settings → Knowledge & Memory → Long-Term Memory", or open the same tab in the right drawer via the "Knowledge · Memory · Schedule" icon at the bottom of the sidebar or `Ctrl/⌘+Shift+M`.

## What Nomi Remembers

- **Conversation memories**: When you close the window, start a new conversation, or every 10 messages, Nomi summarizes the conversation into a "Title + Summary + Keywords" entry; you can also click "Summarize this conversation". Summarization uses the active chat model.
- **About me**: Long-term facts you state explicitly (preferred name, preferences, goals, etc.) are extracted automatically during summarization and can be added, edited, or deleted; you can also tell Nomi directly to "remember…". Passwords, keys, ID numbers, and other sensitive data are filtered out.
- **User profile**: A Markdown file you write yourself (name, work, habits, how you want the assistant to respond), referenced in every conversation; stored in `persona.md` and editable in any text editor.
- **Reply preference profile**: Rule-extracted reply preferences (language / style / tone), which can be reset at any time.

## Natural Recall

Before each prompt, Nomi retrieves relevant memories as background context and indicates in the reply how many memories were referenced. "Recall at most" adjusts the maximum count. Enabling vector search in the knowledge base improves recall accuracy.

Matching only one or two generic words (such as "current" or "what") does not count as relevant: recall requires matching at least roughly a quarter of the words in your question, and past conversation summaries carry at most 160 characters each. Memories already brought into a conversation stay in context without being injected repeatedly; when a conversation is compacted, recalled memories are preserved alongside the summary. After editing your user profile, the very next message picks up the updated version.

## Management

- Search (press `/` to focus), edit, pin (prioritized during recall), or forget individual memories; manually edited entries are never overwritten by automatic summarization.
- Forgetting truly forgets: deleting a conversation summary also deletes the "About me" entries extracted from it; future summaries of that conversation only look at messages sent after the deletion, and deleted entries will not be re-extracted. If you manually add the same fact yourself, your manual entry takes precedence. Clearing all memories follows the same rule. Any in-flight summarization running at the time of deletion is discarded so pre-deletion content is never written back.
- Under "Settings & Export", you can disable long-term memory or auto-summarization, export memories to JSON or Markdown, or clear all memories (both conversation memories and "About me"; cannot be undone).
- When long-term memory is turned off, new conversations are no longer summarized and memories are not referenced in replies; existing memories remain intact.

## Implementation

- Data is stored locally in `userData/memory/` (`memory.json`, `settings.json`, `persona.md`) and never uploaded.
- Recall uses BM25 plus optional vectors (reusing the service configured under Knowledge Base → "Vectors & reranking", subject to the same cloud consent and "Only local models can read files" restrictions).
- AI tools: `memory_search` and `memory_remember`; writes are recorded in the local audit log.
- Core: `apps/desktop-go/internal/core/memory`; UI: `packages/ai-chat/src/components/MemoryPanel`.
