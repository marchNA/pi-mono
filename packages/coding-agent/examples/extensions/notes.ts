/**
 * Structured Notes Extension - Agentic Memory for Long-Horizon Tasks
 *
 * Implements "Structured Note-taking" as described in Anthropic's
 * "Effective Context Engineering for AI Agents":
 * https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
 *
 * The agent regularly writes notes persisted outside the context window.
 * Notes are pulled back into the context window at the start of each turn,
 * providing persistent memory with minimal overhead.
 *
 * Hybrid persistence model:
 * - Session-level: Notes state snapshots in tool result details (supports branching)
 * - Project-level: Notes exported to .pi/notes/ on session shutdown, loaded on new session
 *   Each note file has a "task" summary header so the LLM can identify which
 *   note set is relevant when starting a new session.
 *
 * This enables:
 * - Tracking progress across complex tasks after compaction
 * - Maintaining critical context and dependencies across dozens of tool calls
 * - Coherent multi-hour work sessions with context resets
 * - Resuming work on the same task across different sessions
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ============================================================================
// Types
// ============================================================================

/** A single note entry within a section */
interface NoteEntry {
	text: string;
	timestamp: number;
}

/** A named section of notes */
interface NoteSection {
	name: string;
	entries: NoteEntry[];
}

/** Full notes state, stored in tool result details */
interface NotesState {
	/** Short task description — acts as index key for cross-session lookup */
	task: string;
	sections: NoteSection[];
	lastUpdated: number;
}

/** Details stored in tool result for state reconstruction */
interface NotesToolDetails {
	action: "read" | "write" | "append" | "clear" | "list" | "set_task" | "load";
	section?: string;
	state: NotesState;
	error?: string;
}

/** Project-level note file stored in .pi/notes/ */
interface ProjectNote {
	task: string;
	sections: NoteSection[];
	lastUpdated: number;
	/** ID of the file (derived from filename) */
	id: string;
}

// ============================================================================
// Constants
// ============================================================================

const NOTES_TOOL_NAME = "notes";
const NOTES_DIR = ".pi/notes";

/** Default sections to suggest in the tool description */
const SUGGESTED_SECTIONS = ["progress", "decisions", "context", "blockers", "next-steps"];

/** Number of turns without a notes update before nudging the LLM */
const NUDGE_INTERVAL_TURNS = 5;

/** Context usage threshold (0-1) at which we warn the LLM to save notes */
const CONTEXT_PRESSURE_THRESHOLD = 0.7;

/**
 * Soft budget for notes injected into system prompt (in characters).
 * Notes are NEVER truncated — this only controls when consolidation hints appear.
 */
const NOTES_SOFT_BUDGET_CHARS = 8000;

// ============================================================================
// Tool Parameters
// ============================================================================

const NotesParams = Type.Object({
	action: StringEnum(["read", "write", "append", "clear", "list", "set_task", "load"] as const, {
		description:
			"Action to perform. " +
			"'read': read a section or all notes. " +
			"'write': overwrite a section. " +
			"'append': add an entry to a section. " +
			"'clear': clear a section or all notes. " +
			"'list': list all section names. " +
			"'set_task': set the task summary for this note set (required before first write). " +
			"'load': load a previous note set by id (from project-level storage).",
	}),
	section: Type.Optional(
		Type.String({
			description:
				"Section name (e.g., 'progress', 'decisions', 'context', 'blockers', 'next-steps'). Omit to operate on all sections.",
		}),
	),
	content: Type.Optional(
		Type.String({
			description:
				"Note content. For write/append: the note text. For set_task: the task summary. For load: the note id.",
		}),
	),
});

// ============================================================================
// Project-Level Persistence
// ============================================================================

function getNotesDir(cwd: string): string {
	return path.join(cwd, NOTES_DIR);
}

function ensureNotesDir(cwd: string): string {
	const dir = getNotesDir(cwd);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	return dir;
}

/** Generate a stable filename from task string */
function taskToId(task: string): string {
	// Simple hash: lowercase, replace non-alphanum with dashes, truncate
	const slug = task
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.substring(0, 60);
	// Add a short hash suffix for uniqueness
	let hash = 0;
	for (let i = 0; i < task.length; i++) {
		hash = ((hash << 5) - hash + task.charCodeAt(i)) | 0;
	}
	const hashStr = Math.abs(hash).toString(36).substring(0, 6);
	return `${slug}-${hashStr}`;
}

/** Save current notes to project-level storage */
function saveToProject(cwd: string, state: NotesState): void {
	if (!state.task || state.sections.length === 0) return;

	const dir = ensureNotesDir(cwd);
	const id = taskToId(state.task);
	const filePath = path.join(dir, `${id}.json`);
	const data: ProjectNote = {
		id,
		task: state.task,
		sections: state.sections,
		lastUpdated: state.lastUpdated,
	};
	fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

/** Load all project-level notes (just summaries for index) */
function loadProjectIndex(cwd: string): ProjectNote[] {
	const dir = getNotesDir(cwd);
	if (!fs.existsSync(dir)) return [];

	const notes: ProjectNote[] = [];
	for (const file of fs.readdirSync(dir)) {
		if (!file.endsWith(".json")) continue;
		try {
			const raw = fs.readFileSync(path.join(dir, file), "utf-8");
			const data = JSON.parse(raw) as ProjectNote;
			if (data.task && data.sections) {
				data.id = file.replace(/\.json$/, "");
				notes.push(data);
			}
		} catch {
			// Skip corrupt files
		}
	}

	// Sort by lastUpdated descending (most recent first)
	notes.sort((a, b) => b.lastUpdated - a.lastUpdated);
	return notes;
}

/** Load a specific project-level note by id */
function loadProjectNote(cwd: string, id: string): ProjectNote | undefined {
	const filePath = path.join(getNotesDir(cwd), `${id}.json`);
	if (!fs.existsSync(filePath)) return undefined;
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		const data = JSON.parse(raw) as ProjectNote;
		data.id = id;
		return data;
	} catch {
		return undefined;
	}
}

// ============================================================================
// Helper Functions
// ============================================================================

function createEmptyState(): NotesState {
	return { task: "", sections: [], lastUpdated: Date.now() };
}

function cloneState(state: NotesState): NotesState {
	return {
		task: state.task,
		sections: state.sections.map((s) => ({
			name: s.name,
			entries: s.entries.map((e) => ({ ...e })),
		})),
		lastUpdated: state.lastUpdated,
	};
}

function getOrCreateSection(state: NotesState, name: string): NoteSection {
	let section = state.sections.find((s) => s.name === name);
	if (!section) {
		section = { name, entries: [] };
		state.sections.push(section);
	}
	return section;
}

function formatNotesForContext(state: NotesState, projectNotes: ProjectNote[]): string {
	const lines: string[] = [];
	lines.push("## Agent Notes (Persistent Memory)");
	lines.push("");

	if (!state.task && state.sections.length === 0) {
		// No active notes — show project index if available
		lines.push("No active notes in this session.");
		lines.push("");
		lines.push("You have a `notes` tool for persistent memory that survives context compaction.");
		lines.push("Before writing notes, set a task summary with action 'set_task' so notes");
		lines.push("can be identified across sessions.");
		lines.push("");

		if (projectNotes.length > 0) {
			lines.push("### Previous note sets available in this project:");
			lines.push("");
			for (const pn of projectNotes) {
				const date = new Date(pn.lastUpdated);
				const dateStr = date.toLocaleDateString();
				const sectionNames = pn.sections
					.filter((s) => s.entries.length > 0)
					.map((s) => s.name)
					.join(", ");
				lines.push(`- **${pn.task}** (id: \`${pn.id}\`, ${dateStr}, sections: ${sectionNames})`);
			}
			lines.push("");
			lines.push("To resume a previous task, use the notes tool with action 'load' and");
			lines.push("set content to the note id. Or use 'set_task' to start fresh.");
		}
		lines.push("");
		return lines.join("\n");
	}

	// Active notes exist
	if (state.task) {
		lines.push(`**Task:** ${state.task}`);
		lines.push("");
	}
	lines.push("These notes persist across context compaction. Update them to track progress.");
	lines.push("");

	for (const section of state.sections) {
		if (section.entries.length === 0) continue;

		lines.push(`### ${section.name}`);
		for (const entry of section.entries) {
			const entryLines = entry.text.split("\n");
			lines.push(entryLines[0]);
			for (let i = 1; i < entryLines.length; i++) {
				lines.push(entryLines[i]);
			}
		}
		lines.push("");
	}

	// Budget-aware hints: measure notes content size and warn if over soft budget
	const notesContent = lines.join("\n");
	const currentSize = notesContent.length;
	const budgetPercent = Math.round((currentSize / NOTES_SOFT_BUDGET_CHARS) * 100);

	if (currentSize > NOTES_SOFT_BUDGET_CHARS * 0.9) {
		lines.push("---");
		lines.push(
			`**Notes budget: ${budgetPercent}%** (${currentSize}/${NOTES_SOFT_BUDGET_CHARS} chars). ` +
				"Notes are consuming significant context space. Use action 'write' to replace verbose " +
				"sections with concise summaries. Remove obsolete entries with 'clear'.",
		);
		lines.push("");
	} else if (currentSize > NOTES_SOFT_BUDGET_CHARS * 0.6) {
		lines.push(
			`*Notes: ${budgetPercent}% of budget (${currentSize}/${NOTES_SOFT_BUDGET_CHARS} chars). Consolidate if needed.*`,
		);
		lines.push("");
	}

	return lines.join("\n");
}

// ============================================================================
// UI Component for /notes command
// ============================================================================

class NotesViewComponent {
	private state: NotesState;
	private projectNotes: ProjectNote[];
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(state: NotesState, projectNotes: ProjectNote[], theme: Theme, onClose: () => void) {
		this.state = state;
		this.projectNotes = projectNotes;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "enter")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const th = this.theme;

		lines.push("");
		const title = th.fg("accent", " Agent Notes ");
		const headerLine =
			th.fg("borderMuted", "\u2500".repeat(3)) +
			title +
			th.fg("borderMuted", "\u2500".repeat(Math.max(0, width - 16)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		if (this.state.task) {
			lines.push(truncateToWidth(`  ${th.fg("accent", "Task:")} ${th.fg("text", this.state.task)}`, width));
			lines.push("");
		}

		if (this.state.sections.length === 0) {
			lines.push(
				truncateToWidth(`  ${th.fg("dim", "No notes yet. The agent will create notes as it works.")}`, width),
			);
		} else {
			for (const section of this.state.sections) {
				if (section.entries.length === 0) continue;

				lines.push(truncateToWidth(`  ${th.fg("accent", th.bold(`[${section.name}]`))}`, width));
				lines.push("");

				for (const entry of section.entries) {
					const date = new Date(entry.timestamp);
					const timeStr = `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
					const entryLines = entry.text.split("\n");
					lines.push(truncateToWidth(`    ${th.fg("dim", timeStr)} ${th.fg("text", entryLines[0])}`, width));
					for (let i = 1; i < entryLines.length; i++) {
						lines.push(truncateToWidth(`           ${th.fg("text", entryLines[i])}`, width));
					}
				}
				lines.push("");
			}

			const lastUpdated = new Date(this.state.lastUpdated);
			lines.push(
				truncateToWidth(
					`  ${th.fg("dim", `Last updated: ${lastUpdated.toLocaleTimeString()} | ${this.state.sections.length} section(s)`)}`,
					width,
				),
			);
		}

		// Show project-level notes index
		if (this.projectNotes.length > 0) {
			lines.push("");
			const projTitle = th.fg("accent", " Project Notes ");
			const projLine =
				th.fg("borderMuted", "\u2500".repeat(3)) +
				projTitle +
				th.fg("borderMuted", "\u2500".repeat(Math.max(0, width - 18)));
			lines.push(truncateToWidth(projLine, width));
			lines.push("");

			for (const pn of this.projectNotes) {
				const date = new Date(pn.lastUpdated);
				const dateStr = `${date.getMonth() + 1}/${date.getDate()}`;
				const isActive = pn.task === this.state.task;
				const marker = isActive ? th.fg("success", "\u25cf ") : "  ";
				lines.push(truncateToWidth(`${marker}${th.fg("accent", pn.id)} ${th.fg("dim", dateStr)}`, width));
				lines.push(truncateToWidth(`    ${th.fg("text", pn.task)}`, width));
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape or Enter to close")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

// ============================================================================
// Extension Entry Point
// ============================================================================

export default function (pi: ExtensionAPI) {
	// In-memory state (reconstructed from session on load)
	let notesState: NotesState = createEmptyState();

	// Cached project notes index (refreshed on session start)
	let projectNotes: ProjectNote[] = [];

	// Current working directory (set on session start)
	let cwd = "";

	// ========================================================================
	// Proactive detection state
	// ========================================================================

	/** Turns since the LLM last called the notes tool */
	let turnsSinceLastNoteUpdate = 0;

	/** Whether we already sent a context-pressure warning in this agent loop */
	let contextPressureWarned = false;

	/**
	 * Reconstruct notes state from session entries.
	 * Scans tool results for this tool and uses the latest state snapshot.
	 */
	const reconstructState = (ctx: ExtensionContext) => {
		notesState = createEmptyState();
		cwd = ctx.cwd;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== NOTES_TOOL_NAME) continue;

			const details = msg.details as NotesToolDetails | undefined;
			if (details?.state) {
				notesState = cloneState(details.state);
			}
		}

		// Refresh project index
		projectNotes = loadProjectIndex(cwd);
	};

	// Reconstruct state on session events
	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_switch", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_fork", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	// ========================================================================
	// Inject notes into compaction as custom instructions
	// ========================================================================

	pi.on("session_before_compact", async (event) => {
		if (notesState.sections.length === 0) return;

		const notesContext: string[] = [];
		notesContext.push("The agent has persistent notes that should inform the compaction summary.");
		notesContext.push("Prioritize preserving information relevant to these notes and their task.");
		notesContext.push("Do NOT repeat the notes content verbatim — they persist separately.");
		notesContext.push("");

		if (notesState.task) {
			notesContext.push(`Current task: ${notesState.task}`);
		}

		for (const section of notesState.sections) {
			if (section.entries.length === 0) continue;
			notesContext.push(`Notes section "${section.name}":`);
			for (const entry of section.entries) {
				notesContext.push(`  - ${entry.text.split("\n")[0]}`);
			}
		}

		const existing = event.customInstructions ?? "";
		const combined = existing ? `${existing}\n\n${notesContext.join("\n")}` : notesContext.join("\n");

		return { customInstructions: combined };
	});

	// ========================================================================
	// Save notes to project-level storage on shutdown
	// ========================================================================

	pi.on("session_shutdown", async () => {
		if (cwd && notesState.task && notesState.sections.length > 0) {
			saveToProject(cwd, notesState);
		}
	});

	// Also save after compaction (good checkpoint)
	pi.on("session_compact", async () => {
		if (cwd && notesState.task && notesState.sections.length > 0) {
			saveToProject(cwd, notesState);
		}

		// Post-compaction reminder
		if (notesState.sections.length > 0) {
			const sectionList = notesState.sections
				.filter((s) => s.entries.length > 0)
				.map((s) => s.name)
				.join(", ");
			pi.sendMessage(
				{
					customType: "notes-post-compaction",
					content:
						`[System] Context was compacted. Your persistent notes (task: "${notesState.task}") ` +
						`are still available with sections: ${sectionList}. ` +
						"Review them with the notes tool (action: read) to restore context, " +
						"then update them with any new progress.",
					display: false,
				},
				{ deliverAs: "nextTurn" },
			);
		}

		contextPressureWarned = false;
		turnsSinceLastNoteUpdate = 0;
	});

	// ========================================================================
	// Proactive detection: reset counters on agent start
	// ========================================================================

	pi.on("agent_start", async () => {
		contextPressureWarned = false;
	});

	// ========================================================================
	// Proactive detection: track turns and nudge LLM to update notes
	// ========================================================================

	pi.on("turn_end", async (event, ctx) => {
		const turnUsedNotes = event.toolResults.some((tr) => tr.toolName === NOTES_TOOL_NAME);

		if (turnUsedNotes) {
			turnsSinceLastNoteUpdate = 0;
			// Save to project on every notes update
			if (cwd && notesState.task && notesState.sections.length > 0) {
				saveToProject(cwd, notesState);
			}
		} else {
			turnsSinceLastNoteUpdate++;
		}

		if (turnsSinceLastNoteUpdate >= NUDGE_INTERVAL_TURNS) {
			pi.sendMessage(
				{
					customType: "notes-nudge",
					content:
						"[System] You have not updated your notes in a while. " +
						"Consider using the notes tool to record progress, decisions, or important context " +
						"before this information is lost to context compaction.",
					display: false,
				},
				{ deliverAs: "nextTurn" },
			);
			turnsSinceLastNoteUpdate = 0;
		}

		if (!contextPressureWarned) {
			const usage = ctx.getContextUsage();
			if (usage && usage.percent != null && usage.percent >= CONTEXT_PRESSURE_THRESHOLD) {
				contextPressureWarned = true;
				pi.sendMessage(
					{
						customType: "notes-context-pressure",
						content:
							`[System] Context usage is at ${Math.round(usage.percent * 100)}%. ` +
							"Compaction may occur soon. Use the notes tool NOW to save any critical " +
							"context, progress, and decisions that should survive compaction.",
						display: false,
					},
					{ deliverAs: "nextTurn" },
				);
			}
		}
	});

	// ========================================================================
	// Inject notes into context before each agent turn
	// ========================================================================

	pi.on("before_agent_start", async (event, _ctx) => {
		const notesContext = formatNotesForContext(notesState, projectNotes);

		return {
			systemPrompt: `${event.systemPrompt}\n\n${notesContext}`,
		};
	});

	// ========================================================================
	// Register the notes tool for the LLM
	// ========================================================================

	pi.registerTool({
		name: NOTES_TOOL_NAME,
		label: "Notes",
		description: `Manage persistent notes that survive context compaction and can be resumed across sessions.

Notes are organized in sections. Suggested sections: ${SUGGESTED_SECTIONS.join(", ")}.

WORKFLOW for new tasks:
1. First, use 'set_task' to set a short task description (e.g., "Refactor auth module")
2. Then use 'append'/'write' to add notes to sections as you work

WORKFLOW for resuming previous tasks:
1. Check the system prompt for "Previous note sets available"
2. Use 'load' with the note id to restore a previous note set

Actions:
- 'set_task': Set the task summary (REQUIRED before first write in a new note set)
- 'load': Load a previous note set by id from project storage
- 'read': Read a section or all notes
- 'write': Overwrite a section entirely
- 'append': Add an entry to a section
- 'clear': Clear a section or all notes
- 'list': List all section names

Update notes regularly during long tasks to preserve context across compaction.`,
		parameters: NotesParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const now = Date.now();

			switch (params.action) {
				case "set_task": {
					if (!params.content) {
						return {
							content: [{ type: "text", text: "Error: content required — provide a short task description" }],
							details: {
								action: "set_task",
								state: cloneState(notesState),
								error: "content required",
							} as NotesToolDetails,
						};
					}

					notesState.task = params.content;
					notesState.lastUpdated = now;

					return {
						content: [{ type: "text", text: `Task set to: "${params.content}"` }],
						details: {
							action: "set_task",
							state: cloneState(notesState),
						} as NotesToolDetails,
					};
				}

				case "load": {
					if (!params.content) {
						return {
							content: [{ type: "text", text: "Error: content required — provide the note id to load" }],
							details: {
								action: "load",
								state: cloneState(notesState),
								error: "content required (note id)",
							} as NotesToolDetails,
						};
					}

					const loaded = loadProjectNote(cwd, params.content);
					if (!loaded) {
						// List available IDs for the LLM
						const available = projectNotes.map((pn) => `  - ${pn.id}: ${pn.task}`).join("\n");
						return {
							content: [
								{
									type: "text",
									text: `Note '${params.content}' not found.\n\nAvailable notes:\n${available || "(none)"}`,
								},
							],
							details: {
								action: "load",
								state: cloneState(notesState),
								error: `not found: ${params.content}`,
							} as NotesToolDetails,
						};
					}

					notesState = {
						task: loaded.task,
						sections: loaded.sections.map((s) => ({
							name: s.name,
							entries: s.entries.map((e) => ({ ...e })),
						})),
						lastUpdated: now,
					};

					const sectionSummary = notesState.sections
						.filter((s) => s.entries.length > 0)
						.map((s) => `- ${s.name} (${s.entries.length} entries)`)
						.join("\n");

					return {
						content: [
							{
								type: "text",
								text: `Loaded notes for task: "${loaded.task}"\n\nSections:\n${sectionSummary}\n\nUse action 'read' to review the full content.`,
							},
						],
						details: {
							action: "load",
							state: cloneState(notesState),
						} as NotesToolDetails,
					};
				}

				case "list": {
					const sectionNames = notesState.sections
						.filter((s) => s.entries.length > 0)
						.map((s) => `- ${s.name} (${s.entries.length} entries)`);

					let text = notesState.task ? `Task: "${notesState.task}"\n\n` : "";
					text += sectionNames.length ? `Sections:\n${sectionNames.join("\n")}` : "No notes yet.";

					return {
						content: [{ type: "text", text }],
						details: {
							action: "list",
							state: cloneState(notesState),
						} as NotesToolDetails,
					};
				}

				case "read": {
					if (params.section) {
						const section = notesState.sections.find((s) => s.name === params.section);
						if (!section || section.entries.length === 0) {
							return {
								content: [{ type: "text", text: `Section '${params.section}' is empty or does not exist.` }],
								details: {
									action: "read",
									section: params.section,
									state: cloneState(notesState),
								} as NotesToolDetails,
							};
						}
						const text = section.entries.map((e) => e.text).join("\n\n");
						return {
							content: [{ type: "text", text: `[${section.name}]\n${text}` }],
							details: {
								action: "read",
								section: params.section,
								state: cloneState(notesState),
							} as NotesToolDetails,
						};
					}

					if (notesState.sections.length === 0) {
						return {
							content: [{ type: "text", text: "No notes yet." }],
							details: { action: "read", state: cloneState(notesState) } as NotesToolDetails,
						};
					}
					const allText = notesState.sections
						.filter((s) => s.entries.length > 0)
						.map((s) => `[${s.name}]\n${s.entries.map((e) => e.text).join("\n\n")}`)
						.join("\n\n---\n\n");
					return {
						content: [{ type: "text", text: allText }],
						details: { action: "read", state: cloneState(notesState) } as NotesToolDetails,
					};
				}

				case "write": {
					if (!params.section) {
						return {
							content: [{ type: "text", text: "Error: section name required for write" }],
							details: {
								action: "write",
								state: cloneState(notesState),
								error: "section required",
							} as NotesToolDetails,
						};
					}
					if (!params.content) {
						return {
							content: [{ type: "text", text: "Error: content required for write" }],
							details: {
								action: "write",
								section: params.section,
								state: cloneState(notesState),
								error: "content required",
							} as NotesToolDetails,
						};
					}

					const section = getOrCreateSection(notesState, params.section);
					section.entries = [{ text: params.content, timestamp: now }];
					notesState.lastUpdated = now;

					return {
						content: [{ type: "text", text: `Wrote to section '${params.section}'.` }],
						details: {
							action: "write",
							section: params.section,
							state: cloneState(notesState),
						} as NotesToolDetails,
					};
				}

				case "append": {
					if (!params.section) {
						return {
							content: [{ type: "text", text: "Error: section name required for append" }],
							details: {
								action: "append",
								state: cloneState(notesState),
								error: "section required",
							} as NotesToolDetails,
						};
					}
					if (!params.content) {
						return {
							content: [{ type: "text", text: "Error: content required for append" }],
							details: {
								action: "append",
								section: params.section,
								state: cloneState(notesState),
								error: "content required",
							} as NotesToolDetails,
						};
					}

					const section = getOrCreateSection(notesState, params.section);
					section.entries.push({ text: params.content, timestamp: now });
					notesState.lastUpdated = now;

					return {
						content: [
							{
								type: "text",
								text: `Appended to section '${params.section}' (${section.entries.length} entries).`,
							},
						],
						details: {
							action: "append",
							section: params.section,
							state: cloneState(notesState),
						} as NotesToolDetails,
					};
				}

				case "clear": {
					if (params.section) {
						const idx = notesState.sections.findIndex((s) => s.name === params.section);
						if (idx >= 0) {
							notesState.sections.splice(idx, 1);
						}
						notesState.lastUpdated = now;
						return {
							content: [{ type: "text", text: `Cleared section '${params.section}'.` }],
							details: {
								action: "clear",
								section: params.section,
								state: cloneState(notesState),
							} as NotesToolDetails,
						};
					}

					const count = notesState.sections.length;
					const oldTask = notesState.task;
					notesState = createEmptyState();
					notesState.task = oldTask; // Preserve task on clear
					return {
						content: [{ type: "text", text: `Cleared all notes (${count} sections). Task preserved.` }],
						details: { action: "clear", state: cloneState(notesState) } as NotesToolDetails,
					};
				}

				default:
					return {
						content: [{ type: "text", text: `Unknown action: ${params.action}` }],
						details: {
							action: "list",
							state: cloneState(notesState),
							error: `unknown action: ${params.action}`,
						} as NotesToolDetails,
					};
			}
		},

		// ====================================================================
		// Custom Rendering
		// ====================================================================

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("notes ")) + theme.fg("muted", args.action);
			if (args.section) text += ` ${theme.fg("accent", args.section)}`;
			if (args.content) {
				const preview = args.content.length > 60 ? `${args.content.substring(0, 60)}...` : args.content;
				text += ` ${theme.fg("dim", `"${preview}"`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as NotesToolDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			switch (details.action) {
				case "set_task":
					return new Text(theme.fg("success", "\u2713 Task: ") + theme.fg("accent", details.state.task), 0, 0);

				case "load":
					return new Text(theme.fg("success", "\u2713 Loaded: ") + theme.fg("accent", details.state.task), 0, 0);

				case "list": {
					const sections = details.state.sections.filter((s) => s.entries.length > 0);
					if (sections.length === 0) {
						return new Text(theme.fg("dim", "No notes"), 0, 0);
					}
					let text = theme.fg("muted", `${sections.length} section(s)`);
					if (expanded) {
						for (const s of sections) {
							text += `\n  ${theme.fg("accent", s.name)} ${theme.fg("dim", `(${s.entries.length})`)}`;
						}
					}
					return new Text(text, 0, 0);
				}

				case "read": {
					const content = result.content[0];
					const msg = content?.type === "text" ? content.text : "";
					if (!expanded) {
						const firstLine = msg.split("\n")[0];
						return new Text(
							theme.fg("success", "\u2713 ") +
								theme.fg("muted", firstLine.length > 80 ? `${firstLine.substring(0, 80)}...` : firstLine),
							0,
							0,
						);
					}
					return new Text(theme.fg("muted", msg), 0, 0);
				}

				case "write":
					return new Text(theme.fg("success", "\u2713 Wrote ") + theme.fg("accent", details.section ?? ""), 0, 0);

				case "append":
					return new Text(
						theme.fg("success", "\u2713 Appended to ") + theme.fg("accent", details.section ?? ""),
						0,
						0,
					);

				case "clear":
					return new Text(
						theme.fg("success", "\u2713 Cleared ") + theme.fg("muted", details.section ?? "all notes"),
						0,
						0,
					);
			}
		},
	});

	// ========================================================================
	// Register the /notes command for users
	// ========================================================================

	pi.registerCommand("notes", {
		description: "View current agent notes and project-level note index",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/notes requires interactive mode", "error");
				return;
			}

			// Refresh project index
			projectNotes = loadProjectIndex(ctx.cwd);

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new NotesViewComponent(cloneState(notesState), projectNotes, theme, () => done());
			});
		},
	});
}
