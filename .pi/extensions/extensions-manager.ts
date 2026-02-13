import type { ExtensionContext, ExtensionCommandContext } from "@anthropic/pi-coding-agent/extensions";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

/**
 * Extension manager: list, install, and open extension directories.
 *
 * Commands:
 *   /extensions          — list all loaded extensions (project + global)
 *   /extensions install  — install an example extension to project or global dir
 *   /extensions open     — open extension directory in file explorer
 */
export default function extensionsManager(pi: ExtensionContext) {
	const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..", "..", "..");
	const examplesDir = path.join(repoRoot, "packages", "coding-agent", "examples", "extensions");

	function getGlobalExtDir(): string {
		return path.join(os.homedir(), ".pi", "agent", "extensions");
	}

	function getProjectExtDir(cwd: string): string {
		return path.join(cwd, ".pi", "extensions");
	}

	function listExtensionsInDir(dir: string): string[] {
		try {
			return fs.readdirSync(dir).filter((f) => f.endsWith(".ts"));
		} catch {
			return [];
		}
	}

	function getAvailableExamples(): string[] {
		try {
			return fs.readdirSync(examplesDir).filter((f) => f.endsWith(".ts"));
		} catch {
			return [];
		}
	}

	pi.registerCommand("extensions", {
		description: "Manage extensions: list, install, open",
		handler: async (args, ctx) => {
			const subcommand = args.trim().split(/\s+/)[0] || "list";

			if (subcommand === "list") {
				handleList(ctx);
			} else if (subcommand === "install") {
				await handleInstall(ctx);
			} else if (subcommand === "open") {
				handleOpen(ctx);
			} else {
				ctx.ui.notify(`Unknown subcommand: ${subcommand}. Use: list, install, open`, "error");
			}
		},
	});

	function handleList(ctx: ExtensionCommandContext) {
		const projectDir = getProjectExtDir(ctx.cwd);
		const globalDir = getGlobalExtDir();
		const projectExts = listExtensionsInDir(projectDir);
		const globalExts = listExtensionsInDir(globalDir);

		const lines: string[] = [];
		lines.push("=== Loaded Extensions ===");
		lines.push("");

		lines.push(`Project (${projectDir}):`);
		if (projectExts.length === 0) {
			lines.push("  (none)");
		} else {
			for (const ext of projectExts) {
				lines.push(`  - ${ext}`);
			}
		}

		lines.push("");
		lines.push(`Global (${globalDir}):`);
		if (globalExts.length === 0) {
			lines.push("  (none)");
		} else {
			for (const ext of globalExts) {
				lines.push(`  - ${ext}`);
			}
		}

		lines.push("");
		lines.push(`Total: ${projectExts.length + globalExts.length} extension(s)`);
		lines.push("");
		lines.push("Subcommands: /extensions list | install | open");

		ctx.ui.notify(lines.join("\n"), "info");
	}

	async function handleInstall(ctx: ExtensionCommandContext) {
		if (!ctx.hasUI) {
			ctx.ui.notify("/extensions install requires interactive mode", "error");
			return;
		}

		const examples = getAvailableExamples();
		if (examples.length === 0) {
			ctx.ui.notify("No example extensions found in: " + examplesDir, "error");
			return;
		}

		const projectDir = getProjectExtDir(ctx.cwd);
		const globalDir = getGlobalExtDir();
		const projectExts = new Set(listExtensionsInDir(projectDir));
		const globalExts = new Set(listExtensionsInDir(globalDir));

		// Build items list with install status
		const items = examples.map((name) => {
			const inProject = projectExts.has(name);
			const inGlobal = globalExts.has(name);
			const suffix = inProject ? " [installed: project]" : inGlobal ? " [installed: global]" : "";
			return { label: `${name}${suffix}`, name };
		});

		const selectedLabel = await ctx.ui.select(
			"Select extension to install:",
			items.map((i) => i.label),
		);
		if (!selectedLabel) return;

		const selected = items.find((i) => i.label === selectedLabel);
		if (!selected) return;

		// Choose target: project or global
		const target = await ctx.ui.select("Install to:", [
			"project (.pi/extensions/)",
			"global (~/.pi/agent/extensions/)",
		]);
		if (!target) return;

		const isProject = target.startsWith("project");
		const targetDir = isProject ? projectDir : globalDir;
		const srcPath = path.join(examplesDir, selected.name);
		const destPath = path.join(targetDir, selected.name);

		fs.mkdirSync(targetDir, { recursive: true });

		if (fs.existsSync(destPath)) {
			const overwrite = await ctx.ui.confirm(
				"Overwrite?",
				`${selected.name} already exists in ${isProject ? "project" : "global"}. Overwrite?`,
			);
			if (!overwrite) {
				ctx.ui.notify("Installation cancelled.", "info");
				return;
			}
		}

		try {
			fs.copyFileSync(srcPath, destPath);
			ctx.ui.notify(
				`Installed ${selected.name} to ${isProject ? "project" : "global"} extensions.\nRestart pi to load it.`,
				"info",
			);
		} catch (err) {
			ctx.ui.notify(`Failed to install: ${err}`, "error");
		}
	}

	function handleOpen(ctx: ExtensionCommandContext) {
		const projectDir = getProjectExtDir(ctx.cwd);
		const globalDir = getGlobalExtDir();

		const opener = process.platform === "win32" ? "explorer" : process.platform === "darwin" ? "open" : "xdg-open";

		const lines: string[] = [];
		lines.push("Extension directories:");
		lines.push(`  Project: ${projectDir}`);
		lines.push(`  Global:  ${globalDir}`);

		try {
			if (fs.existsSync(projectDir)) {
				execSync(`${opener} "${projectDir}"`);
				lines.push("");
				lines.push("Opened project extensions directory.");
			}
		} catch {
			// ignore - best effort
		}

		ctx.ui.notify(lines.join("\n"), "info");
	}
}
