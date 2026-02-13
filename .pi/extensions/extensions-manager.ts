import type { ExtensionContext } from "@anthropic/pi-coding-agent/extensions";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

export default function extensionsManager(pi: ExtensionContext) {
	// Derive examples dir from the cli entry point (process.argv[1] = .../src/cli.ts)
	const cliPath = process.argv[1] || "";
	const pkgDir = path.resolve(path.dirname(cliPath), "..");
	const examplesDir = path.join(pkgDir, "examples", "extensions");

	function getGlobalExtDir(): string {
		return path.join(os.homedir(), ".pi", "agent", "extensions");
	}

	function getProjectExtDir(cwd: string): string {
		return path.join(cwd, ".pi", "extensions");
	}

	function listDir(dir: string): string[] {
		try {
			return fs.readdirSync(dir).filter((f) => f.endsWith(".ts"));
		} catch {
			return [];
		}
	}

	pi.registerCommand("extensions", {
		description: "Manage extensions: list, install, open",
		handler: async (args, ctx) => {
			try {
				const sub = args.trim().split(/\s+/)[0] || "list";

				if (sub === "install") {
					await doInstall(ctx);
					return;
				}

				if (sub === "open") {
					doOpen(ctx);
					return;
				}

				// Default: list
				const pDir = getProjectExtDir(ctx.cwd);
				const gDir = getGlobalExtDir();
				const pExts = listDir(pDir);
				const gExts = listDir(gDir);

				const lines: string[] = [];
				lines.push("=== Loaded Extensions ===");
				lines.push("");
				lines.push(`Project (${pDir}):`);
				for (const e of pExts) lines.push(`  - ${e}`);
				if (pExts.length === 0) lines.push("  (none)");
				lines.push("");
				lines.push(`Global (${gDir}):`);
				for (const e of gExts) lines.push(`  - ${e}`);
				if (gExts.length === 0) lines.push("  (none)");
				lines.push("");
				lines.push(`Total: ${pExts.length + gExts.length} extension(s)`);
				lines.push("");
				lines.push("Subcommands: /extensions list | install | open");

				ctx.ui.notify(lines.join("\n"), "info");
			} catch (err) {
				ctx.ui.notify(`Error: ${err}`, "error");
			}
		},
	});

	async function doInstall(ctx: Parameters<NonNullable<Parameters<typeof pi.registerCommand>[1]["handler"]>>[1]) {
		if (!ctx.hasUI) {
			ctx.ui.notify("Requires interactive mode.", "error");
			return;
		}

		const examples = listDir(examplesDir);
		if (examples.length === 0) {
			ctx.ui.notify("No examples found in: " + examplesDir, "error");
			return;
		}

		const pDir = getProjectExtDir(ctx.cwd);
		const gDir = getGlobalExtDir();
		const installed = new Set([...listDir(pDir), ...listDir(gDir)]);

		const labels = examples.map((n) => (installed.has(n) ? `${n} [installed]` : n));
		const picked = await ctx.ui.select("Select extension:", labels);
		if (!picked) return;

		const name = picked.replace(/ \[installed\]$/, "");
		const target = await ctx.ui.select("Install to:", ["project", "global"]);
		if (!target) return;

		const destDir = target === "project" ? pDir : gDir;
		fs.mkdirSync(destDir, { recursive: true });

		const dest = path.join(destDir, name);
		if (fs.existsSync(dest)) {
			const ok = await ctx.ui.confirm("Overwrite?", `${name} already exists. Overwrite?`);
			if (!ok) return;
		}

		fs.copyFileSync(path.join(examplesDir, name), dest);
		ctx.ui.notify(`Installed ${name} to ${target}. Restart pi to load.`, "info");
	}

	function doOpen(ctx: Parameters<NonNullable<Parameters<typeof pi.registerCommand>[1]["handler"]>>[1]) {
		const pDir = getProjectExtDir(ctx.cwd);
		const gDir = getGlobalExtDir();
		const opener = process.platform === "win32" ? "explorer" : process.platform === "darwin" ? "open" : "xdg-open";
		try {
			if (fs.existsSync(pDir)) execSync(`${opener} "${pDir}"`);
		} catch {
			// ignore
		}
		ctx.ui.notify(`Project: ${pDir}\nGlobal: ${gDir}`, "info");
	}
}
