/**
 * Context Pruning Extension - Tool Result Historical Compression
 *
 * Reduces context bloat by replacing old tool result contents with
 * short summaries. Only modifies the copy sent to the LLM (via the
 * `context` event), session data is never touched.
 *
 * Based on Anthropic's "Effective Context Engineering for AI Agents":
 * "Once a tool has been called deep in the message history, why would
 * the agent need to see the raw result again?"
 *
 * Behavior:
 * - The most recent KEEP_RECENT_RESULTS tool results are kept intact
 * - Older tool results have their content replaced with a one-line summary
 * - Error results are kept intact longer (KEEP_RECENT_ERRORS)
 * - Image content is always stripped from old results (just notes "[image]")
 * - The notes tool is never pruned (it's the agent's persistent memory)
 */

import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ============================================================================
// Constants
// ============================================================================

/** Number of most recent tool results to keep fully intact */
const KEEP_RECENT_RESULTS = 6;

/** Number of most recent error results to keep fully intact */
const KEEP_RECENT_ERRORS = 10;

/** Tool names that should never be pruned */
const NEVER_PRUNE_TOOLS = new Set(["notes"]);

/** Max chars of original content to include in summary hint */
const SUMMARY_HINT_CHARS = 120;

// ============================================================================
// Summarization
// ============================================================================

interface ToolResultLike {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	details?: unknown;
	isError: boolean;
	timestamp: number;
}

/**
 * Create a short summary for a tool result based on tool name and content.
 */
function summarizeToolResult(msg: ToolResultLike): string {
	const textParts = msg.content.filter((c): c is TextContent => c.type === "text");
	const imageCount = msg.content.filter((c) => c.type === "image").length;
	const fullText = textParts.map((t) => t.text).join("\n");

	let summary = "";

	switch (msg.toolName) {
		case "read": {
			// Extract file path from details or content
			const details = msg.details as Record<string, unknown> | undefined;
			const filePath = details?.path ?? details?.filePath ?? "";
			const lineCount = (fullText.match(/\n/g) || []).length + 1;
			summary = `[Pruned] Read ${filePath} (${lineCount} lines)`;
			break;
		}
		case "bash": {
			const details = msg.details as Record<string, unknown> | undefined;
			const command = details?.command ?? "";
			const exitCode = details?.exitCode ?? details?.code;
			const commandStr = typeof command === "string" ? command : "";
			const truncCmd = commandStr.length > 80 ? `${commandStr.substring(0, 80)}...` : commandStr;
			summary = `[Pruned] Bash: \`${truncCmd}\``;
			if (exitCode !== undefined && exitCode !== 0) {
				summary += ` (exit ${exitCode})`;
			}
			break;
		}
		case "edit": {
			const details = msg.details as Record<string, unknown> | undefined;
			const filePath = details?.path ?? "";
			if (msg.isError) {
				summary = `[Pruned] Edit ${filePath} — FAILED`;
			} else {
				summary = `[Pruned] Edit ${filePath} — applied`;
			}
			break;
		}
		case "write": {
			const details = msg.details as Record<string, unknown> | undefined;
			const filePath = details?.path ?? "";
			summary = `[Pruned] Write ${filePath}`;
			break;
		}
		case "grep": {
			const details = msg.details as Record<string, unknown> | undefined;
			const pattern = details?.pattern ?? "";
			const matchCount = details?.matchCount ?? details?.matches;
			summary = `[Pruned] Grep "${pattern}"`;
			if (matchCount !== undefined) {
				summary += ` (${matchCount} matches)`;
			}
			break;
		}
		case "find": {
			const details = msg.details as Record<string, unknown> | undefined;
			const pattern = details?.pattern ?? details?.glob ?? "";
			summary = `[Pruned] Find "${pattern}"`;
			break;
		}
		case "ls": {
			const details = msg.details as Record<string, unknown> | undefined;
			const dirPath = details?.path ?? "";
			summary = `[Pruned] ls ${dirPath}`;
			break;
		}
		default: {
			// Generic summary for unknown tools
			summary = `[Pruned] ${msg.toolName}`;
			if (fullText.length > 0) {
				const hint = fullText.substring(0, SUMMARY_HINT_CHARS).replace(/\n/g, " ");
				summary += `: ${hint}`;
				if (fullText.length > SUMMARY_HINT_CHARS) summary += "...";
			}
			break;
		}
	}

	if (imageCount > 0) {
		summary += ` [${imageCount} image(s)]`;
	}

	if (msg.isError && !summary.includes("FAILED")) {
		summary += " [error]";
	}

	return summary;
}

// ============================================================================
// Extension Entry Point
// ============================================================================

export default function (pi: ExtensionAPI) {
	pi.on("context", async (event) => {
		const messages = event.messages;

		// Collect indices of all toolResult messages, from end to start
		const toolResultIndices: number[] = [];

		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "toolResult") {
				toolResultIndices.push(i);
			}
		}

		// Nothing to prune
		if (toolResultIndices.length <= KEEP_RECENT_RESULTS) {
			return;
		}

		// Track how many recent results and errors we've seen
		let recentResultsSeen = 0;
		let recentErrorsSeen = 0;

		for (const idx of toolResultIndices) {
			const msg = messages[idx] as ToolResultLike;

			// Never prune protected tools
			if (NEVER_PRUNE_TOOLS.has(msg.toolName)) continue;

			recentResultsSeen++;

			// Keep recent results intact
			if (recentResultsSeen <= KEEP_RECENT_RESULTS) continue;

			// Keep recent errors intact (they have diagnostic value)
			if (msg.isError) {
				recentErrorsSeen++;
				if (recentErrorsSeen <= KEEP_RECENT_ERRORS) continue;
			}

			// Prune: replace content with summary
			const summary = summarizeToolResult(msg);
			msg.content = [{ type: "text", text: summary }];
			// Clear details to save tokens (details can be large)
			msg.details = undefined;
		}

		return { messages };
	});
}
