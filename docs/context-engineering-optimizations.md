# Context Engineering Optimizations

Based on Anthropic's "Effective Context Engineering for AI Agents" (Sep 29, 2025).
https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

## Current Status

| Practice | Status | Notes |
|----------|--------|-------|
| Structured Note-taking | Done | notes extension with soft budget, cross-session persistence |
| Compaction | Built-in | LLM-based summarization + tool result clearing |
| Sub-agent Architecture | Example only | `examples/extensions/subagent/` |
| Just-in-time Context Retrieval | Built-in | read/grep/find tools, AGENTS.md naive injection |
| Tool Result Pruning | Partial | 50KB/2000-line truncation per call, no historical pruning |
| Context Pollution Prevention | None | No dedup or noise reduction for message history |

## Optimization Opportunities

### 1. Tool Result Historical Pruning (High Priority)

**Problem:** Old tool results stay fully intact in context. A `read` of a 2000-line file from 20 turns ago still occupies the same tokens as when it was first returned. The article explicitly recommends: "once a tool has been called deep in the message history, why would the agent need to see the raw result again?"

**Approach:** Create an extension using the `context` event to modify messages before each LLM call:
- For tool results older than N turns, replace content with a short summary (e.g., "Read file X (2000 lines)" or "Bash: ran `npm test`, exit code 0")
- Keep the most recent K tool results intact
- Preserve error results longer (they contain diagnostic info)
- Never touch tool results from the current agent loop

**Implementation:** `context` event handler in an extension. Non-destructive (only modifies the copy sent to LLM, session data untouched).

**Files:** New extension `examples/extensions/context-pruning.ts`

---

### 2. Compaction + Notes Linkage (Medium Priority)

**Problem:** Compaction summarizes conversation history but doesn't know about the agent's structured notes. Notes could provide better anchors for the summary. After compaction, the agent has to manually re-read notes.

**Approach:**
- In `session_before_compact`: inject notes content into the compaction prompt as additional context, so the summarizer knows what the agent considers important
- In `session_compact`: auto-update notes progress section with a compaction marker ("Context compacted at turn N, summary preserved")
- Consider: let the compaction summary reference notes sections instead of duplicating their content

**Files:** Modify `examples/extensions/notes.ts` compaction handlers

---

### 3. Failure Retry Deduplication (Medium Priority)

**Problem:** When an `edit` tool fails (oldText mismatch) and the agent retries 3-4 times, all failed attempts remain in context. Each failed attempt includes the full oldText and newText, which can be thousands of characters. This is pure noise.

**Approach:** In the `context` event:
- Detect consecutive failed tool calls of the same type (edit, write) on the same file
- Keep only the last failure and the final success
- Replace intermediate failures with a one-line summary: "edit failed 3 times on file X (oldText mismatch)"

**Files:** Could be part of `context-pruning.ts` or separate extension

---

### 4. AGENTS.md / Rules File On-Demand Loading (Low Priority)

**Problem:** AGENTS.md and similar rules files are injected into the system prompt in full at startup. For large projects with detailed rules, this can consume significant context before the agent even starts working.

**Approach:** Instead of full injection:
- Inject only a table of contents / summary of available rules
- Provide a tool or mechanism for the agent to load specific sections on demand
- Cache frequently accessed sections

**Trade-off:** More tool calls vs. smaller baseline context. May not be worth it for typical AGENTS.md sizes (< 5KB). Only relevant for very large rule sets.

**Files:** Would require changes to `src/core/system-prompt.ts` or a new extension

---

### 5. Sub-agent Result Compression (Low Priority)

**Problem:** The existing subagent example spawns child agents but their full output goes into the parent context. The article recommends: "Each subagent might explore extensively, using tens of thousands of tokens or more, but returns only a condensed, distilled summary of its work (often 1,000-2,000 tokens)."

**Approach:**
- Enforce a max output size for subagent results
- Have subagents summarize their own findings before returning
- Parent agent receives only the distilled summary

**Files:** Modify `examples/extensions/subagent/`

---

### 6. Duplicate Read Detection (Low Priority)

**Problem:** Agents sometimes read the same file multiple times in the same session. Each read returns the full file content, bloating context with duplicate data.

**Approach:** In `context` event or `tool_result` event:
- Track which files have been read and their content hashes
- For subsequent reads of unchanged files, replace the full content with "File X unchanged since last read (turn N)"
- Only apply to reads with no offset/limit changes

**Files:** Could be part of `context-pruning.ts`

---

## Priority Order

1. **Tool Result Historical Pruning** — highest impact, most context savings
2. **Failure Retry Deduplication** — common scenario, easy win
3. **Compaction + Notes Linkage** — improves compaction quality
4. **Duplicate Read Detection** — moderate savings
5. **AGENTS.md On-Demand Loading** — only relevant for large rule sets
6. **Sub-agent Result Compression** — niche use case

## References

- Anthropic article: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- pi extension docs: `packages/coding-agent/docs/extensions.md`
- Existing compaction: `packages/coding-agent/src/core/compaction/`
- Notes extension: `packages/coding-agent/examples/extensions/notes.ts`
