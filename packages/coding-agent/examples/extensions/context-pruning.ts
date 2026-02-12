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

import type { ImageContent, TextContent, ToolCall } from "@mariozechner/pi-ai";
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
// Tool Call Argument Extraction
// ============================================================================

/**
 * Build a map from toolCallId to the tool call's input arguments.
 * This lets us extract path, command, etc. from the assistant's tool_call
 * content rather than from the tool result's details (which may not have them).
 */
function buildToolCallArgsMap(messages: unknown[]): Map<string, Record<string, unknown>> {
	const map = new Map<string, Record<string, unknown>>();
	for (const msg of messages) {
		const m = msg as { role?: string; content?: unknown[] };
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const content of m.content) {
			const c = content as { type?: string };
			if (c.type === "toolCall") {
				const tc = content as ToolCall;
				map.set(tc.id, tc.arguments);
			}
		}
	}
	return map;
}

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
 * Create a short summary for a tool result based on tool name,
 * the tool call's input arguments, and the result content.
 */
function summarizeToolResult(msg: ToolResultLike, args: Record<string, unknown> | undefined): string {
	const textParts = msg.content.filter((c): c is TextContent => c.type === "text");
	const imageCount = msg.content.filter((c) => c.type === "image").length;
	const fullText = textParts.map((t) => t.text).join("\n");

	let summary = "";

	switch (msg.toolName) {
		case "read": {
			const filePath = args?.path ?? "";
			const lineCount = (fullText.match(/\n/g) || []).length + 1;
			summary = `[Pruned] Read ${filePath} (${lineCount} lines)`;
			if (imageCount > 0) {
				summary += ` [${imageCount} image(s)]`;
			}
			break;
		}
		case "bash": {
			const command = typeof args?.command === "string" ? args.command : "";
			const truncCmd = command.length > 80 ? `${command.substring(0, 80)}...` : command;
			// Try to extract exit code from output text
			const exitMatch = fullText.match(/exit(?:ed with)?\s*(?:code\s*)?(\d+)/i);
			summary = `[Pruned] Bash: \`${truncCmd}\``;
			if (msg.isError) {
				summary += exitMatch ? ` (exit ${exitMatch[1]})` : " (error)";
			} else if (exitMatch && exitMatch[1] !== "0") {
				summary += ` (exit ${exitMatch[1]})`;
			}
			break;
		}
		case "edit": {
			const filePath = args?.path ?? "";
			if (msg.isError) {
				summary = `[Pruned] Edit ${filePath} — FAILED`;
			} else {
				summary = `[Pruned] Edit ${filePath} — applied`;
			}
			break;
		}
		case "write": {
			const filePath = args?.path ?? "";
			summary = `[Pruned] Write ${filePath}`;
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
			if (imageCount > 0) {
				summary += ` [${imageCount} image(s)]`;
			}
			break;
		}
	}

	if (msg.isError && !summary.includes("FAILED") && !summary.includes("error")) {
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

		// Build toolCallId -> arguments map from assistant messages
		const argsMap = buildToolCallArgsMap(messages);

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
			const args = argsMap.get(msg.toolCallId);
			const summary = summarizeToolResult(msg, args);
			msg.content = [{ type: "text", text: summary }];
			// Clear details to save tokens (details can be large)
			msg.details = undefined;
		}

		return { messages };
	});
}
