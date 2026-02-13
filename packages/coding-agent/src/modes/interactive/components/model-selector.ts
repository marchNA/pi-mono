import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Model, modelsAreEqual } from "@mariozechner/pi-ai";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	getEditorKeybindings,
	Input,
	Spacer,
	Text,
	type TUI,
} from "@mariozechner/pi-tui";
import type { ModelRegistry } from "../../../core/model-registry.js";
import type { SettingsManager } from "../../../core/settings-manager.js";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyHint } from "./keybinding-hints.js";

interface ModelItem {
	provider: string;
	id: string;
	model: Model<any>;
}

interface ScopedModelItem {
	model: Model<any>;
	thinkingLevel: string;
}

type ModelScope = "all" | "scoped";

/** Internal mode: "select" for model picking, "edit-providers" for provider toggles, "edit-models" for per-model toggles, "add-provider" for adding custom provider */
type SelectorMode = "select" | "edit-providers" | "edit-models" | "add-provider";

/**
 * Component that renders a model selector with search
 */
export class ModelSelectorComponent extends Container implements Focusable {
	private searchInput: Input;

	// Focusable implementation - propagate to searchInput for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}
	private listContainer: Container;
	private allModels: ModelItem[] = [];
	private scopedModelItems: ModelItem[] = [];
	private activeModels: ModelItem[] = [];
	private filteredModels: ModelItem[] = [];
	private selectedIndex: number = 0;
	/** When true, the cursor is on the "Edit visible providers" action row at the bottom */
	private onEditAction = false;
	private currentModel?: Model<any>;
	private settingsManager: SettingsManager;
	private modelRegistry: ModelRegistry;
	private onSelectCallback: (model: Model<any>) => void;
	private onCancelCallback: () => void;
	private errorMessage?: string;
	private tui: TUI;
	private scopedModels: ReadonlyArray<ScopedModelItem>;
	private scope: ModelScope = "all";
	private scopeText?: Text;
	private scopeHintText?: Text;

	// Provider/model visibility editor state
	private selectorMode: SelectorMode = "select";
	private allProviderNames: string[] = [];
	private providerCursor = 0;
	private providerHidden: Set<string> = new Set();
	// Per-model editor state
	private editingProvider = "";
	private editingModels: Array<{ provider: string; id: string }> = [];
	private modelEditorCursor = 0;
	private modelHidden: Set<string> = new Set(); // "provider/modelId" format
	// Add custom provider state
	private onAddProviderAction = false; // When cursor is on "+ Add custom provider" row
	private addProviderStep: "name" | "baseUrl" | "apiKey" | "api" | "modelId" | "confirm" = "name";
	private addProviderInput!: Input;
	private static readonly API_OPTIONS = [
		{ value: "openai" as const, label: "OpenAI Compatible" },
		{ value: "anthropic" as const, label: "Anthropic Compatible" },
	];
	private apiOptionIndex = 0; // cursor index into API_OPTIONS
	private addProviderData = {
		name: "",
		baseUrl: "",
		apiKey: "",
		api: "openai" as "openai" | "anthropic",
		modelId: "",
	};

	constructor(
		tui: TUI,
		currentModel: Model<any> | undefined,
		settingsManager: SettingsManager,
		modelRegistry: ModelRegistry,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		onSelect: (model: Model<any>) => void,
		onCancel: () => void,
		initialSearchInput?: string,
	) {
		super();

		this.tui = tui;
		this.currentModel = currentModel;
		this.settingsManager = settingsManager;
		this.modelRegistry = modelRegistry;
		this.scopedModels = scopedModels;
		this.scope = scopedModels.length > 0 ? "scoped" : "all";
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Add hint about model filtering
		if (scopedModels.length > 0) {
			this.scopeText = new Text(this.getScopeText(), 0, 0);
			this.addChild(this.scopeText);
			this.scopeHintText = new Text(this.getScopeHintText(), 0, 0);
			this.addChild(this.scopeHintText);
		} else {
			const hintText = "Only showing models with configured API keys (see README for details)";
			this.addChild(new Text(theme.fg("warning", hintText), 0, 0));
		}
		this.addChild(new Spacer(1));

		// Create search input
		this.searchInput = new Input();
		if (initialSearchInput) {
			this.searchInput.setValue(initialSearchInput);
		}
		this.searchInput.onSubmit = () => {
			if (this.onEditAction) {
				this.enterEditProvidersMode();
			} else if (this.onAddProviderAction) {
				this.enterAddProviderMode();
			} else if (this.filteredModels[this.selectedIndex]) {
				this.handleSelect(this.filteredModels[this.selectedIndex].model);
			}
		};
		this.addChild(this.searchInput);

		this.addChild(new Spacer(1));

		// Create list container
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));

		// Add bottom border
		this.addChild(new DynamicBorder());

		// Load models and do initial render
		this.loadModels().then(() => {
			if (initialSearchInput) {
				this.filterModels(initialSearchInput);
			} else {
				this.updateList();
			}
			// Request re-render after models are loaded
			this.tui.requestRender();
		});
	}

	private async loadModels(): Promise<void> {
		let models: ModelItem[];

		// Refresh to pick up any changes to models.json
		this.modelRegistry.refresh();

		// Check for models.json errors
		const loadError = this.modelRegistry.getError();
		if (loadError) {
			this.errorMessage = loadError;
		}

		// Load hidden providers and models from settings
		const hiddenProviders = new Set(this.settingsManager.getHiddenProviders());
		const hiddenModels = new Set(this.settingsManager.getHiddenModels());

		// Load available models (built-in models still work even if models.json failed)
		try {
			const availableModels = await this.modelRegistry.getAvailable();
			models = availableModels
				.filter(
					(model: Model<any>) =>
						!hiddenProviders.has(model.provider) && !hiddenModels.has(`${model.provider}/${model.id}`),
				)
				.map((model: Model<any>) => ({
					provider: model.provider,
					id: model.id,
					model,
				}));
		} catch (error) {
			this.allModels = [];
			this.scopedModelItems = [];
			this.activeModels = [];
			this.filteredModels = [];
			this.errorMessage = error instanceof Error ? error.message : String(error);
			return;
		}

		this.allModels = this.sortModels(models);
		this.scopedModelItems = this.sortModels(
			this.scopedModels
				.filter(
					(scoped) =>
						!hiddenProviders.has(scoped.model.provider) &&
						!hiddenModels.has(`${scoped.model.provider}/${scoped.model.id}`),
				)
				.map((scoped) => ({
					provider: scoped.model.provider,
					id: scoped.model.id,
					model: scoped.model,
				})),
		);
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		this.filteredModels = this.activeModels;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
		this.onEditAction = false;
	}

	private sortModels(models: ModelItem[]): ModelItem[] {
		const sorted = [...models];
		// Sort: current model first, then by provider
		sorted.sort((a, b) => {
			const aIsCurrent = modelsAreEqual(this.currentModel, a.model);
			const bIsCurrent = modelsAreEqual(this.currentModel, b.model);
			if (aIsCurrent && !bIsCurrent) return -1;
			if (!aIsCurrent && bIsCurrent) return 1;
			return a.provider.localeCompare(b.provider);
		});
		return sorted;
	}

	private getScopeText(): string {
		const allText = this.scope === "all" ? theme.fg("accent", "all") : theme.fg("muted", "all");
		const scopedText = this.scope === "scoped" ? theme.fg("accent", "scoped") : theme.fg("muted", "scoped");
		return `${theme.fg("muted", "Scope: ")}${allText}${theme.fg("muted", " | ")}${scopedText}`;
	}

	private getScopeHintText(): string {
		return keyHint("tab", "scope") + theme.fg("muted", " (all/scoped)");
	}

	private setScope(scope: ModelScope): void {
		if (this.scope === scope) return;
		this.scope = scope;
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		this.selectedIndex = 0;
		this.onEditAction = false;
		this.filterModels(this.searchInput.getValue());
		if (this.scopeText) {
			this.scopeText.setText(this.getScopeText());
		}
	}

	private filterModels(query: string): void {
		this.filteredModels = query
			? fuzzyFilter(this.activeModels, query, ({ id, provider }) => `${id} ${provider}`)
			: this.activeModels;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
		this.onEditAction = false;
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();

		const maxVisible = 15;

		// Group filtered models by provider
		const groups = new Map<string, ModelItem[]>();
		for (const item of this.filteredModels) {
			const list = groups.get(item.provider) ?? [];
			list.push(item);
			groups.set(item.provider, list);
		}

		// Build flat display list with provider headers
		interface DisplayRow {
			type: "provider" | "model" | "action";
			text: string;
			modelIndex?: number; // index in filteredModels
		}
		const rows: DisplayRow[] = [];
		let flatIdx = 0;
		for (const [provider, items] of groups) {
			rows.push({ type: "provider", text: provider });
			for (const item of items) {
				const isCurrent = modelsAreEqual(this.currentModel, item.model);
				const isSelected = flatIdx === this.selectedIndex && !this.onEditAction && !this.onAddProviderAction;
				const checkmark = isCurrent ? theme.fg("success", " ✓") : "";

				let line: string;
				if (isSelected) {
					line = `  ${theme.fg("accent", `→ ${item.id}`)}${checkmark}`;
				} else {
					line = `    ${item.id}${checkmark}`;
				}
				rows.push({ type: "model", text: line, modelIndex: flatIdx });
				flatIdx++;
			}
		}

		// Add action rows at the bottom (only when not searching)
		if (!this.searchInput.getValue()) {
			rows.push({ type: "action", text: "edit" });
			rows.push({ type: "action", text: "add" });
		}

		// Find the row index of the selected item for scrolling
		let selectedRowIdx = 0;
		if (this.onEditAction) {
			selectedRowIdx = rows.length - 2; // "Edit visible providers" is second-to-last
		} else if (this.onAddProviderAction) {
			selectedRowIdx = rows.length - 1; // "Add custom provider" is last
		} else {
			for (let i = 0; i < rows.length; i++) {
				if (rows[i]?.modelIndex === this.selectedIndex) {
					selectedRowIdx = i;
					break;
				}
			}
		}

		// Scroll window
		const startRow = Math.max(0, Math.min(selectedRowIdx - Math.floor(maxVisible / 2), rows.length - maxVisible));
		const endRow = Math.min(startRow + maxVisible, rows.length);

		for (let i = startRow; i < endRow; i++) {
			const row = rows[i];
			if (!row) continue;
			if (row.type === "provider") {
				this.listContainer.addChild(new Text(theme.fg("warning", `▸ ${row.text}`), 0, 0));
			} else if (row.type === "action") {
				if (row.text === "edit") {
					const actionLine = this.onEditAction
						? theme.fg("accent", "→ ⚙ Edit visible providers")
						: theme.fg("dim", "  ⚙ Edit visible providers");
					this.listContainer.addChild(new Text(actionLine, 0, 0));
				} else if (row.text === "add") {
					const actionLine = this.onAddProviderAction
						? theme.fg("accent", "→ + Add custom provider")
						: theme.fg("dim", "  + Add custom provider");
					this.listContainer.addChild(new Text(actionLine, 0, 0));
				}
			} else {
				this.listContainer.addChild(new Text(row.text, 0, 0));
			}
		}

		// Scroll indicator
		if (startRow > 0 || endRow < rows.length) {
			const scrollInfo = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredModels.length})`);
			this.listContainer.addChild(new Text(scrollInfo, 0, 0));
		}

		// Error / empty / detail
		if (this.errorMessage) {
			const errorLines = this.errorMessage.split("\n");
			for (const line of errorLines) {
				this.listContainer.addChild(new Text(theme.fg("error", line), 0, 0));
			}
		} else if (this.filteredModels.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
		} else if (!this.onEditAction && !this.onAddProviderAction) {
			const selected = this.filteredModels[this.selectedIndex];
			if (selected) {
				this.listContainer.addChild(new Spacer(1));
				this.listContainer.addChild(new Text(theme.fg("muted", `  ${selected.model.name}`), 0, 0));
			}
		}
	}

	// =========================================================================
	// Provider visibility editor
	// =========================================================================

	private enterEditProvidersMode(): void {
		this.selectorMode = "edit-providers";

		// Collect all available provider names (before filtering)
		const providerSet = new Set<string>();
		try {
			const models = this.modelRegistry.getAll();
			for (const m of models) {
				if (this.modelRegistry.authStorage.hasAuth(m.provider)) {
					providerSet.add(m.provider);
				}
			}
		} catch {
			// fall back to what we have
			for (const item of this.allModels) {
				providerSet.add(item.provider);
			}
		}
		this.allProviderNames = [...providerSet].sort();
		this.providerHidden = new Set(this.settingsManager.getHiddenProviders());
		this.providerCursor = 0;
		this.renderProviderEditor();
	}

	private renderProviderEditor(): void {
		this.listContainer.clear();

		this.listContainer.addChild(new Text(theme.fg("warning", "Edit visible providers"), 0, 0));
		this.listContainer.addChild(new Text(theme.fg("dim", "Toggle which providers appear in the model list"), 0, 0));
		this.listContainer.addChild(new Spacer(1));

		const maxVisible = 15;
		const startIdx = Math.max(
			0,
			Math.min(this.providerCursor - Math.floor(maxVisible / 2), this.allProviderNames.length - maxVisible),
		);
		const endIdx = Math.min(startIdx + maxVisible, this.allProviderNames.length);

		for (let i = startIdx; i < endIdx; i++) {
			const name = this.allProviderNames[i];
			if (!name) continue;
			const isHidden = this.providerHidden.has(name);
			const isCursor = i === this.providerCursor;
			const checkbox = isHidden ? "[ ]" : "[x]";

			let line: string;
			if (isCursor) {
				line = theme.fg("accent", `→ ${checkbox} ${name}`);
			} else {
				line = `  ${checkbox} ${name}`;
			}
			this.listContainer.addChild(new Text(line, 0, 0));
		}

		if (startIdx > 0 || endIdx < this.allProviderNames.length) {
			this.listContainer.addChild(
				new Text(theme.fg("muted", `  (${this.providerCursor + 1}/${this.allProviderNames.length})`), 0, 0),
			);
		}

		this.listContainer.addChild(new Spacer(1));
		this.listContainer.addChild(
			new Text(
				`(Space: toggle, ${keyHint("selectConfirm", "to edit models,")} ${keyHint("selectCancel", "to save & go back")})`,
				0,
				0,
			),
		);

		this.tui.requestRender();
	}

	private saveProviderVisibility(): void {
		this.settingsManager.setHiddenProviders([...this.providerHidden]);
	}

	private saveModelVisibility(): void {
		this.settingsManager.setHiddenModels([...this.modelHidden]);
	}

	private exitEditProvidersMode(): void {
		this.saveProviderVisibility();
		this.saveModelVisibility();
		this.selectorMode = "select";
		this.onEditAction = false;
		this.selectedIndex = 0;
		// Reload models with new visibility
		this.loadModels().then(() => {
			this.filterModels(this.searchInput.getValue());
			this.tui.requestRender();
		});
	}

	// =========================================================================
	// Per-model visibility editor
	// =========================================================================

	private enterEditModelsMode(provider: string): void {
		this.selectorMode = "edit-models";
		this.editingProvider = provider;

		// Collect all models for this provider (with auth)
		const allModels = this.modelRegistry.getAll();
		this.editingModels = allModels
			.filter((m) => m.provider === provider && this.modelRegistry.authStorage.hasAuth(m.provider))
			.map((m) => ({ provider: m.provider, id: m.id }));

		this.modelHidden = new Set(this.settingsManager.getHiddenModels());
		this.modelEditorCursor = 0;
		this.renderModelEditor();
	}

	private renderModelEditor(): void {
		this.listContainer.clear();

		this.listContainer.addChild(new Text(theme.fg("warning", `Edit visible models: ${this.editingProvider}`), 0, 0));
		this.listContainer.addChild(new Text(theme.fg("dim", "Toggle which models appear in the model list"), 0, 0));
		this.listContainer.addChild(new Spacer(1));

		const maxVisible = 15;
		const startIdx = Math.max(
			0,
			Math.min(this.modelEditorCursor - Math.floor(maxVisible / 2), this.editingModels.length - maxVisible),
		);
		const endIdx = Math.min(startIdx + maxVisible, this.editingModels.length);

		for (let i = startIdx; i < endIdx; i++) {
			const model = this.editingModels[i];
			if (!model) continue;
			const key = `${model.provider}/${model.id}`;
			const isHidden = this.modelHidden.has(key);
			const isCursor = i === this.modelEditorCursor;
			const checkbox = isHidden ? "[ ]" : "[x]";

			let line: string;
			if (isCursor) {
				line = theme.fg("accent", `→ ${checkbox} ${model.id}`);
			} else {
				line = `  ${checkbox} ${model.id}`;
			}
			this.listContainer.addChild(new Text(line, 0, 0));
		}

		if (startIdx > 0 || endIdx < this.editingModels.length) {
			this.listContainer.addChild(
				new Text(theme.fg("muted", `  (${this.modelEditorCursor + 1}/${this.editingModels.length})`), 0, 0),
			);
		}

		this.listContainer.addChild(new Spacer(1));
		this.listContainer.addChild(new Text(`(Space: toggle, ${keyHint("selectCancel", "to go back")})`, 0, 0));

		this.tui.requestRender();
	}

	// =========================================================================
	// Input handling
	// =========================================================================

	handleInput(keyData: string): void {
		if (this.selectorMode === "edit-providers") {
			this.handleProviderEditorInput(keyData);
			return;
		}
		if (this.selectorMode === "edit-models") {
			this.handleModelEditorInput(keyData);
			return;
		}
		if (this.selectorMode === "add-provider") {
			this.handleAddProviderInput(keyData);
			return;
		}

		const kb = getEditorKeybindings();
		if (kb.matches(keyData, "tab")) {
			if (this.scopedModelItems.length > 0) {
				const nextScope: ModelScope = this.scope === "all" ? "scoped" : "all";
				this.setScope(nextScope);
				if (this.scopeHintText) {
					this.scopeHintText.setText(this.getScopeHintText());
				}
			}
			return;
		}
		// Up arrow
		if (kb.matches(keyData, "selectUp")) {
			if (this.filteredModels.length === 0) return;
			if (this.onAddProviderAction) {
				this.onAddProviderAction = false;
				this.onEditAction = true;
			} else if (this.onEditAction) {
				this.onEditAction = false;
				this.selectedIndex = this.filteredModels.length - 1;
			} else if (this.selectedIndex === 0) {
				// Wrap: go to add action if no search query
				if (!this.searchInput.getValue()) {
					this.onAddProviderAction = true;
				} else {
					this.selectedIndex = this.filteredModels.length - 1;
				}
			} else {
				this.selectedIndex--;
			}
			this.updateList();
		}
		// Down arrow
		else if (kb.matches(keyData, "selectDown")) {
			if (this.filteredModels.length === 0) return;
			if (this.onAddProviderAction) {
				this.onAddProviderAction = false;
				this.selectedIndex = 0;
			} else if (this.onEditAction) {
				this.onEditAction = false;
				this.onAddProviderAction = true;
			} else if (this.selectedIndex === this.filteredModels.length - 1) {
				// Wrap: go to edit action if no search query
				if (!this.searchInput.getValue()) {
					this.onEditAction = true;
				} else {
					this.selectedIndex = 0;
				}
			} else {
				this.selectedIndex++;
			}
			this.updateList();
		}
		// Enter
		else if (kb.matches(keyData, "selectConfirm")) {
			if (this.onAddProviderAction) {
				this.enterAddProviderMode();
			} else if (this.onEditAction) {
				this.enterEditProvidersMode();
			} else {
				const selectedModel = this.filteredModels[this.selectedIndex];
				if (selectedModel) {
					this.handleSelect(selectedModel.model);
				}
			}
		}
		// Escape or Ctrl+C
		else if (kb.matches(keyData, "selectCancel")) {
			this.onCancelCallback();
		}
		// Pass everything else to search input
		else {
			this.searchInput.handleInput(keyData);
			this.filterModels(this.searchInput.getValue());
		}
	}

	private handleProviderEditorInput(keyData: string): void {
		const kb = getEditorKeybindings();

		if (kb.matches(keyData, "selectUp")) {
			this.providerCursor = Math.max(0, this.providerCursor - 1);
			this.renderProviderEditor();
		} else if (kb.matches(keyData, "selectDown")) {
			this.providerCursor = Math.min(this.allProviderNames.length - 1, this.providerCursor + 1);
			this.renderProviderEditor();
		} else if (keyData === " ") {
			const name = this.allProviderNames[this.providerCursor];
			if (name) {
				if (this.providerHidden.has(name)) {
					this.providerHidden.delete(name);
				} else {
					this.providerHidden.add(name);
				}
			}
			this.renderProviderEditor();
		} else if (kb.matches(keyData, "selectConfirm")) {
			// Enter: drill into per-model editor for this provider
			const name = this.allProviderNames[this.providerCursor];
			if (name) {
				// Save provider visibility first so model list reflects current state
				this.saveProviderVisibility();
				this.enterEditModelsMode(name);
			}
		} else if (kb.matches(keyData, "selectCancel")) {
			// Escape: save and go back to model list
			this.exitEditProvidersMode();
		}
	}

	private handleModelEditorInput(keyData: string): void {
		const kb = getEditorKeybindings();

		if (kb.matches(keyData, "selectUp")) {
			this.modelEditorCursor = Math.max(0, this.modelEditorCursor - 1);
			this.renderModelEditor();
		} else if (kb.matches(keyData, "selectDown")) {
			this.modelEditorCursor = Math.min(this.editingModels.length - 1, this.modelEditorCursor + 1);
			this.renderModelEditor();
		} else if (keyData === " ") {
			const model = this.editingModels[this.modelEditorCursor];
			if (model) {
				const key = `${model.provider}/${model.id}`;
				if (this.modelHidden.has(key)) {
					this.modelHidden.delete(key);
				} else {
					this.modelHidden.add(key);
				}
			}
			this.renderModelEditor();
		} else if (kb.matches(keyData, "selectCancel")) {
			// Escape: save model visibility and go back to provider editor
			this.saveModelVisibility();
			this.selectorMode = "edit-providers";
			this.renderProviderEditor();
		}
	}

	private enterAddProviderMode(): void {
		this.selectorMode = "add-provider";
		this.addProviderStep = "name";
		this.addProviderData = { name: "", baseUrl: "", apiKey: "", api: "openai", modelId: "" };
		this.apiOptionIndex = 0;
		this.addProviderInput = new Input();
		this.addProviderInput.setPlaceholder("Enter provider name (e.g., my-custom)");
		this.renderAddProvider();
	}

	private renderAddProvider(): void {
		this.listContainer.clear();

		const stepLabels = {
			name: "Provider Name",
			baseUrl: "Base URL",
			apiKey: "API Key",
			api: "API Protocol",
			modelId: "Model ID",
			confirm: "Confirm",
		};

		this.listContainer.addChild(new Text(theme.fg("accent", "=== Add Custom Provider ==="), 0, 0));
		this.listContainer.addChild(new Text("", 0, 0));

		// Show current progress
		for (const step of ["name", "baseUrl", "apiKey", "api", "modelId"] as const) {
			const label = stepLabels[step];
			const value = this.addProviderData[step];
			const isCurrent = this.addProviderStep === step;
			const prefix = isCurrent ? "→ " : "  ";
			// Mask API key display
			const displayValue = step === "apiKey" && value ? "••••••••" : value;
			const suffix = displayValue ? `: ${displayValue}` : ": (not set)";
			const text = prefix + label + suffix;
			if (isCurrent) {
				this.listContainer.addChild(new Text(theme.fg("accent", text), 0, 0));
			} else if (value) {
				this.listContainer.addChild(new Text(theme.fg("text", text), 0, 0));
			} else {
				this.listContainer.addChild(new Text(theme.fg("dim", text), 0, 0));
			}
		}

		this.listContainer.addChild(new Text("", 0, 0));

		// Show input or selector for current step
		if (this.addProviderStep === "api") {
			this.listContainer.addChild(new Text(theme.fg("accent", `${stepLabels[this.addProviderStep]}:`), 0, 0));
			for (let i = 0; i < ModelSelectorComponent.API_OPTIONS.length; i++) {
				const opt = ModelSelectorComponent.API_OPTIONS[i]!;
				const isCursor = i === this.apiOptionIndex;
				const radio = isCursor ? "(●)" : "( )";
				const line = isCursor
					? theme.fg("accent", `  ${radio} ${opt.label}`)
					: theme.fg("text", `  ${radio} ${opt.label}`);
				this.listContainer.addChild(new Text(line, 0, 0));
			}
			this.listContainer.addChild(new Text(theme.fg("dim", "  ↑↓ select, Enter confirm"), 0, 0));
		} else if (this.addProviderStep !== "confirm") {
			this.listContainer.addChild(new Text(theme.fg("accent", `${stepLabels[this.addProviderStep]}:`), 0, 0));
			this.listContainer.addChild(this.addProviderInput);
			this.addProviderInput.setPosition(0, this.listContainer.getHeight() - 1);
		} else {
			this.listContainer.addChild(new Text(theme.fg("accent", "Press Enter to save, Escape to cancel"), 0, 0));
		}
	}

	private handleAddProviderInput(keyData: string): void {
		const kb = getEditorKeybindings();

		if (kb.matches(keyData, "selectCancel")) {
			// Escape: go back to select mode
			this.selectorMode = "select";
			this.updateList();
			return;
		}

		if (this.addProviderStep === "confirm") {
			if (kb.matches(keyData, "selectConfirm")) {
				this.saveCustomProvider();
				this.selectorMode = "select";
				this.updateList();
			}
			return;
		}

		// Special handling for API protocol selection - use visual selector
		if (this.addProviderStep === "api") {
			if (kb.matches(keyData, "cursorUp")) {
				this.apiOptionIndex = Math.max(0, this.apiOptionIndex - 1);
				this.addProviderData.api = ModelSelectorComponent.API_OPTIONS[this.apiOptionIndex]!.value;
				this.renderAddProvider();
				return;
			}
			if (kb.matches(keyData, "cursorDown")) {
				this.apiOptionIndex = Math.min(ModelSelectorComponent.API_OPTIONS.length - 1, this.apiOptionIndex + 1);
				this.addProviderData.api = ModelSelectorComponent.API_OPTIONS[this.apiOptionIndex]!.value;
				this.renderAddProvider();
				return;
			}
			if (kb.matches(keyData, "selectConfirm")) {
				this.addProviderStep = "modelId";
				this.addProviderInput.setValue("");
				this.addProviderInput.setPlaceholder("Enter model ID (e.g., gpt-4)");
				this.renderAddProvider();
				return;
			}
			return; // Ignore all other keys in api step
		}

		// Handle input for current step
		if (kb.matches(keyData, "selectConfirm")) {
			const value = this.addProviderInput.getValue().trim();
			if (!value) return; // Don't allow empty values

			switch (this.addProviderStep) {
				case "name":
					this.addProviderData.name = value;
					this.addProviderStep = "baseUrl";
					this.addProviderInput.setValue("");
					this.addProviderInput.setPlaceholder("Enter base URL (e.g., https://api.example.com/v1)");
					break;
				case "baseUrl":
					this.addProviderData.baseUrl = value;
					this.addProviderStep = "apiKey";
					this.addProviderInput.setValue("");
					this.addProviderInput.setPlaceholder("Enter API key");
					break;
				case "apiKey":
					this.addProviderData.apiKey = value;
					this.addProviderStep = "api";
					this.apiOptionIndex = 0;
					this.addProviderData.api = "openai";
					break;
				case "modelId":
					this.addProviderData.modelId = value;
					this.addProviderStep = "confirm";
					break;
			}
			this.renderAddProvider();
		} else {
			// Pass all other input to the input field (handles typing, delete, paste, etc.)
			this.addProviderInput.handleInput(keyData);
		}
	}

	private saveCustomProvider(): void {
		const { name, baseUrl, apiKey, api, modelId } = this.addProviderData;
		if (!name || !baseUrl || !api || !modelId) return;

		const modelsConfigPath = path.join(os.homedir(), ".pi", "agent", "models.json");

		interface CustomModel {
			id: string;
			name: string;
			contextWindow: number;
			maxTokens: number;
		}
		interface CustomProvider {
			baseUrl: string;
			apiKey: string;
			api: string;
			models: CustomModel[];
		}
		interface ModelsConfig {
			providers?: Record<string, CustomProvider>;
		}

		let config: ModelsConfig = {};

		try {
			if (fs.existsSync(modelsConfigPath)) {
				config = JSON.parse(fs.readFileSync(modelsConfigPath, "utf-8"));
			}
		} catch {
			// ignore, create new config
		}

		if (!config.providers) config.providers = {};

		// Add or update the custom provider
		const existingProvider = config.providers[name];
		const newModel: CustomModel = {
			id: modelId,
			name: modelId,
			contextWindow: 128000,
			maxTokens: 16384,
		};

		if (existingProvider) {
			// Provider exists, add model if not already present
			if (!existingProvider.models.some((m) => m.id === modelId)) {
				existingProvider.models.push(newModel);
			}
		} else {
			// Create new provider with the model
			config.providers[name] = {
				baseUrl,
				apiKey,
				api: api === "openai" ? "openai-completions" : "anthropic-messages",
				models: [newModel],
			};
		}

		fs.mkdirSync(path.dirname(modelsConfigPath), { recursive: true });
		fs.writeFileSync(modelsConfigPath, JSON.stringify(config, null, 2));

		// Reload models
		this.modelRegistry.reloadCustomModels();
	}

	private handleSelect(model: Model<any>): void {
		// Save as new default
		this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
		this.onSelectCallback(model);
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
