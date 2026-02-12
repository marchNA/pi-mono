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

/** Internal mode: "select" for model picking, "edit-providers" for visibility toggles */
type SelectorMode = "select" | "edit-providers";

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

	// Provider visibility editor state
	private selectorMode: SelectorMode = "select";
	private allProviderNames: string[] = [];
	private providerCursor = 0;
	private providerHidden: Set<string> = new Set();

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

		// Load hidden providers from settings
		const hiddenProviders = new Set(this.settingsManager.getHiddenProviders());

		// Load available models (built-in models still work even if models.json failed)
		try {
			const availableModels = await this.modelRegistry.getAvailable();
			models = availableModels
				.filter((model: Model<any>) => !hiddenProviders.has(model.provider))
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
				.filter((scoped) => !hiddenProviders.has(scoped.model.provider))
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
				const isSelected = flatIdx === this.selectedIndex && !this.onEditAction;
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

		// Add action row at the bottom (only when not searching)
		if (!this.searchInput.getValue()) {
			rows.push({ type: "action", text: "" });
		}

		// Find the row index of the selected item for scrolling
		let selectedRowIdx = 0;
		if (this.onEditAction) {
			selectedRowIdx = rows.length - 1;
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
				const actionLine = this.onEditAction
					? theme.fg("accent", "→ ⚙ Edit visible providers")
					: theme.fg("dim", "  ⚙ Edit visible providers");
				this.listContainer.addChild(new Text(actionLine, 0, 0));
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
		} else if (!this.onEditAction) {
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
				`(Space: toggle, ${keyHint("selectConfirm", "to save,")} ${keyHint("selectCancel", "to cancel")})`,
				0,
				0,
			),
		);

		this.tui.requestRender();
	}

	private saveProviderVisibility(): void {
		this.settingsManager.setHiddenProviders([...this.providerHidden]);
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
	// Input handling
	// =========================================================================

	handleInput(keyData: string): void {
		if (this.selectorMode === "edit-providers") {
			this.handleProviderEditorInput(keyData);
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
			if (this.onEditAction) {
				this.onEditAction = false;
				this.selectedIndex = this.filteredModels.length - 1;
			} else if (this.selectedIndex === 0) {
				// Wrap: go to edit action if no search query, otherwise wrap to last model
				if (!this.searchInput.getValue()) {
					this.onEditAction = true;
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
			if (this.onEditAction) {
				this.onEditAction = false;
				this.selectedIndex = 0;
			} else if (this.selectedIndex === this.filteredModels.length - 1) {
				// Wrap: go to edit action if no search query, otherwise wrap to first model
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
			if (this.onEditAction) {
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
			this.saveProviderVisibility();
		} else if (kb.matches(keyData, "selectCancel")) {
			// Cancel: go back to model list without saving
			this.selectorMode = "select";
			this.updateList();
			this.tui.requestRender();
		}
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
