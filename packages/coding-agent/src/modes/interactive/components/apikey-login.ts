import { Container, type Focusable, getEditorKeybindings, Input, Spacer, Text, type TUI } from "@mariozechner/pi-tui";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { getModelsPath } from "../../../config.js";
import type { AuthStorage } from "../../../core/auth-storage.js";
import type { ModelRegistry } from "../../../core/model-registry.js";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyHint } from "./keybinding-hints.js";

interface RemoteModel {
	id: string;
	owned_by?: string;
}

type Step = "provider-name" | "api-url" | "api-key" | "fetching" | "model-list" | "done" | "error";

/**
 * Interactive API key login component.
 * Guides the user through configuring a custom OpenAI-compatible provider:
 *   1. Provider name
 *   2. API base URL
 *   3. API key
 *   4. Fetch model list (connectivity test)
 *   5. Select models to enable
 *   6. Save to models.json + auth.json
 */
export class ApiKeyLoginComponent extends Container implements Focusable {
	private contentContainer: Container;
	private input: Input;
	private tui: TUI;
	private modelRegistry: ModelRegistry;
	private authStorage: AuthStorage;
	private onComplete: (success: boolean, message?: string) => void;

	// Collected config
	private providerName = "";
	private apiUrl = "";
	private apiKey = "";
	private remoteModels: RemoteModel[] = [];
	private selectedIndices: Set<number> = new Set();
	private listScrollOffset = 0;
	private listCursor = 0;

	private currentStep: Step = "provider-name";

	// Focusable
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		tui: TUI,
		modelRegistry: ModelRegistry,
		authStorage: AuthStorage,
		onComplete: (success: boolean, message?: string) => void,
	) {
		super();
		this.tui = tui;
		this.modelRegistry = modelRegistry;
		this.authStorage = authStorage;
		this.onComplete = onComplete;

		this.addChild(new DynamicBorder());

		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		this.input = new Input();
		this.input.onSubmit = () => this.handleSubmit();
		this.input.onEscape = () => this.cancel();

		this.addChild(new DynamicBorder());

		this.showStep("provider-name");
	}

	private cancel(): void {
		this.onComplete(false, "Cancelled");
	}

	private showStep(step: Step): void {
		this.currentStep = step;
		this.contentContainer.clear();

		switch (step) {
			case "provider-name":
				this.contentContainer.addChild(
					new Text(theme.fg("warning", "Configure Custom Provider (OpenAI-compatible)"), 1, 0),
				);
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("text", "Provider name:"), 1, 0));
				this.contentContainer.addChild(
					new Text(theme.fg("dim", "A short identifier, e.g. zai, deepseek, local-ollama"), 1, 0),
				);
				this.contentContainer.addChild(new Spacer(1));
				this.input.setValue(this.providerName);
				this.contentContainer.addChild(this.input);
				this.contentContainer.addChild(
					new Text(`(${keyHint("selectConfirm", "to continue,")} ${keyHint("selectCancel", "to cancel")})`, 1, 0),
				);
				break;

			case "api-url":
				this.contentContainer.addChild(new Text(theme.fg("warning", `Provider: ${this.providerName}`), 1, 0));
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("text", "API base URL:"), 1, 0));
				this.contentContainer.addChild(
					new Text(theme.fg("dim", "e.g. https://open.bigmodel.cn/api/coding/paas/v4"), 1, 0),
				);
				this.contentContainer.addChild(new Spacer(1));
				this.input.setValue(this.apiUrl);
				this.contentContainer.addChild(this.input);
				this.contentContainer.addChild(
					new Text(`(${keyHint("selectConfirm", "to continue,")} ${keyHint("selectCancel", "to cancel")})`, 1, 0),
				);
				break;

			case "api-key":
				this.contentContainer.addChild(new Text(theme.fg("warning", `Provider: ${this.providerName}`), 1, 0));
				this.contentContainer.addChild(new Text(theme.fg("dim", `URL: ${this.apiUrl}`), 1, 0));
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("text", "API key:"), 1, 0));
				this.contentContainer.addChild(new Spacer(1));
				this.input.setValue(this.apiKey);
				this.contentContainer.addChild(this.input);
				this.contentContainer.addChild(
					new Text(`(${keyHint("selectConfirm", "to continue,")} ${keyHint("selectCancel", "to cancel")})`, 1, 0),
				);
				break;

			case "fetching":
				this.contentContainer.addChild(new Text(theme.fg("warning", `Provider: ${this.providerName}`), 1, 0));
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("accent", "Fetching model list..."), 1, 0));
				this.contentContainer.addChild(new Text(`(${keyHint("selectCancel", "to cancel")})`, 1, 0));
				break;

			case "model-list":
				this.renderModelList();
				break;

			case "error":
				// Error content is set by showError()
				break;

			case "done":
				break;
		}

		this.tui.requestRender();
	}

	private renderModelList(): void {
		this.contentContainer.clear();
		this.contentContainer.addChild(
			new Text(theme.fg("warning", `${this.providerName} - ${this.remoteModels.length} models available`), 1, 0),
		);
		this.contentContainer.addChild(new Text(theme.fg("dim", `URL: ${this.apiUrl}`), 1, 0));
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(
			new Text(theme.fg("text", "Select models to enable (Space to toggle, Enter to confirm):"), 1, 0),
		);
		this.contentContainer.addChild(new Spacer(1));

		// Show visible models with scroll
		const maxVisible = 15;
		const end = Math.min(this.listScrollOffset + maxVisible, this.remoteModels.length);

		if (this.listScrollOffset > 0) {
			this.contentContainer.addChild(new Text(theme.fg("dim", `  ... ${this.listScrollOffset} more above`), 0, 0));
		}

		for (let i = this.listScrollOffset; i < end; i++) {
			const model = this.remoteModels[i];
			if (!model) continue;
			const isSelected = this.selectedIndices.has(i);
			const isCursor = i === this.listCursor;
			const checkbox = isSelected ? "[x]" : "[ ]";

			let line: string;
			if (isCursor) {
				line = theme.fg("accent", `→ ${checkbox} ${model.id}`);
			} else {
				line = `  ${checkbox} ${model.id}`;
			}
			if (model.owned_by) {
				line += theme.fg("dim", ` (${model.owned_by})`);
			}
			this.contentContainer.addChild(new Text(line, 0, 0));
		}

		if (end < this.remoteModels.length) {
			this.contentContainer.addChild(
				new Text(theme.fg("dim", `  ... ${this.remoteModels.length - end} more below`), 0, 0),
			);
		}

		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(
			new Text(
				`(Space: toggle, a: all, n: none, ${keyHint("selectConfirm", "to save,")} ${keyHint("selectCancel", "to cancel")})`,
				1,
				0,
			),
		);

		this.tui.requestRender();
	}

	private showError(message: string): void {
		this.currentStep = "error";
		this.contentContainer.clear();
		this.contentContainer.addChild(new Text(theme.fg("warning", `Provider: ${this.providerName}`), 1, 0));
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${message}`), 1, 0));
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(`(${keyHint("selectCancel", "to go back")})`, 1, 0));
		this.tui.requestRender();
	}

	private handleSubmit(): void {
		const value = this.input.getValue().trim();

		switch (this.currentStep) {
			case "provider-name": {
				if (!value) return;
				// Validate: no spaces, lowercase-ish
				if (/\s/.test(value)) {
					this.showError("Provider name must not contain spaces");
					return;
				}
				this.providerName = value;
				this.input.setValue("");
				this.showStep("api-url");
				break;
			}
			case "api-url": {
				if (!value) return;
				// Basic URL validation
				if (!value.startsWith("http://") && !value.startsWith("https://")) {
					this.showError("URL must start with http:// or https://");
					return;
				}
				this.apiUrl = value.replace(/\/+$/, ""); // strip trailing slashes
				this.input.setValue("");
				this.showStep("api-key");
				break;
			}
			case "api-key": {
				if (!value) return;
				this.apiKey = value;
				this.input.setValue("");
				this.fetchModels();
				break;
			}
		}
	}

	private async fetchModels(): Promise<void> {
		this.showStep("fetching");

		try {
			// Try /models endpoint (OpenAI-compatible)
			const url = `${this.apiUrl}/models`;
			const response = await fetch(url, {
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
					"Content-Type": "application/json",
				},
				signal: AbortSignal.timeout(15000),
			});

			if (!response.ok) {
				const body = await response.text().catch(() => "");
				this.showError(`HTTP ${response.status}: ${body.substring(0, 200)}`);
				return;
			}

			const data = (await response.json()) as { data?: RemoteModel[] };
			const models = data.data;
			if (!Array.isArray(models) || models.length === 0) {
				this.showError("No models returned from /models endpoint");
				return;
			}

			// Sort by id
			models.sort((a, b) => a.id.localeCompare(b.id));
			this.remoteModels = models;
			this.selectedIndices = new Set();
			this.listCursor = 0;
			this.listScrollOffset = 0;

			this.showStep("model-list");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.showError(`Failed to fetch models: ${msg}`);
		}
	}

	private saveConfig(): void {
		if (this.selectedIndices.size === 0) {
			this.showError("No models selected");
			return;
		}

		const selectedModels = [...this.selectedIndices]
			.sort((a, b) => a - b)
			.map((i) => this.remoteModels[i])
			.filter((m): m is RemoteModel => !!m);

		// Save API key to auth.json
		this.authStorage.set(this.providerName, { type: "api_key", key: this.apiKey });

		// Save provider config to models.json
		const modelsPath = getModelsPath();
		let config: { providers: Record<string, unknown> } = { providers: {} };
		if (existsSync(modelsPath)) {
			try {
				config = JSON.parse(readFileSync(modelsPath, "utf-8"));
				if (!config.providers) config.providers = {};
			} catch {
				config = { providers: {} };
			}
		}

		const modelDefs: Array<{
			id: string;
			name: string;
			contextWindow: number;
			maxTokens: number;
		}> = selectedModels.map((m) => ({
			id: m.id,
			name: m.id,
			contextWindow: 128000,
			maxTokens: 16384,
		}));

		config.providers[this.providerName] = {
			baseUrl: this.apiUrl,
			apiKey: `cmd:pi auth get-key ${this.providerName}`,
			api: "openai-completions",
			models: modelDefs,
		};

		const dir = dirname(modelsPath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(modelsPath, JSON.stringify(config, null, 2), "utf-8");

		// Reload model registry
		this.modelRegistry.refresh();

		const msg = `Configured ${this.providerName} with ${selectedModels.length} model(s). Saved to models.json.`;
		this.onComplete(true, msg);
	}

	handleInput(data: string): void {
		const kb = getEditorKeybindings();

		if (kb.matches(data, "selectCancel")) {
			if (this.currentStep === "error") {
				// Go back to api-key step
				this.showStep("api-key");
				return;
			}
			this.cancel();
			return;
		}

		if (this.currentStep === "model-list") {
			this.handleModelListInput(data, kb);
			return;
		}

		// For text input steps, pass to input
		if (this.currentStep === "provider-name" || this.currentStep === "api-url" || this.currentStep === "api-key") {
			this.input.handleInput(data);
		}
	}

	private handleModelListInput(data: string, kb: ReturnType<typeof getEditorKeybindings>): void {
		const maxVisible = 15;

		if (kb.matches(data, "selectUp")) {
			this.listCursor = Math.max(0, this.listCursor - 1);
			// Scroll up if needed
			if (this.listCursor < this.listScrollOffset) {
				this.listScrollOffset = this.listCursor;
			}
			this.renderModelList();
		} else if (kb.matches(data, "selectDown")) {
			this.listCursor = Math.min(this.remoteModels.length - 1, this.listCursor + 1);
			// Scroll down if needed
			if (this.listCursor >= this.listScrollOffset + maxVisible) {
				this.listScrollOffset = this.listCursor - maxVisible + 1;
			}
			this.renderModelList();
		} else if (data === " ") {
			// Toggle selection
			if (this.selectedIndices.has(this.listCursor)) {
				this.selectedIndices.delete(this.listCursor);
			} else {
				this.selectedIndices.add(this.listCursor);
			}
			this.renderModelList();
		} else if (data === "a") {
			// Select all
			for (let i = 0; i < this.remoteModels.length; i++) {
				this.selectedIndices.add(i);
			}
			this.renderModelList();
		} else if (data === "n") {
			// Deselect all
			this.selectedIndices.clear();
			this.renderModelList();
		} else if (kb.matches(data, "selectConfirm")) {
			this.saveConfig();
		}
	}
}
