import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type ExtensionContext,
	type SessionEntry,
	DynamicBorder,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type KeybindingsManager,
	type TUI,
	Box,
	Container,
	Key,
	Spacer,
	Text,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { applyPrunes } from "./apply";
import { textFromContent } from "./candidates";

export interface PersistedCandidate {
	toolCallId: string;
	toolName: string;
	inputSummary: string;
	inputChars: number;
	resultChars: number;
	isError: boolean;
	keepProbability: number;
	outcome: "keep" | "drop";
}

export interface PersistedRun {
	id: string;
	at: string;
	mode: "dry" | "applied" | "reset";
	goal?: string;
	candidates: PersistedCandidate[];
	rawTokens: number;
	effectiveTokens: number;
	usage: { inputTokens: number; outputTokens: number };
	requestCount: number;
}

export interface PersistedState {
	version: number;
	mode: PersistedRun["mode"];
	activeDroppedIds: string[];
	run: PersistedRun;
}

function formatTokens(tokens: number): string {
	return tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k` : String(tokens);
}

function formatBytes(chars: number): string {
	if (chars >= 1_000_000) return `${(chars / 1_000_000).toFixed(1)} MB`;
	if (chars >= 1_000) return `${(chars / 1_000).toFixed(1)} KB`;
	return `${chars} B`;
}

function estimateCost(inputTokens: number): string {
	const cost = (inputTokens / 1_000_000) * 0.042;
	if (cost < 0.0001) return "<$0.0001";
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	return `$${cost.toFixed(3)}`;
}

/**
 * Register entry renderer for inline transcript cards.
 */
export function createEntryRenderer() {
	return (entry: SessionEntry, { expanded }: { expanded: boolean }, theme: any): Component => {
		const state = entry.type === "custom" ? (entry.data as Partial<PersistedState> | undefined) : undefined;
		const run = state?.run;
		const mode = run?.mode ?? state?.mode ?? "applied";

		const box = new Box(1, 0, (text: string) => theme.bg("customMessageBg", text));
		if (!run) {
			box.addChild(new Text(theme.fg("muted", "[jev-prune] Recorded state"), 0, 0));
			return box;
		}

		const isDry = mode === "dry";
		const isReset = mode === "reset";
		const badgeColor = isDry ? "warning" : isReset ? "muted" : "success";
		const badgeText = `[jev ${mode}]`;

		if (isReset) {
			box.addChild(new Text(`${theme.fg(badgeColor, badgeText)} Reset active pruning decisions · Context restored to ~${formatTokens(run.rawTokens)}`, 0, 0));
			return box;
		}

		const droppedCount = run.candidates.filter((c) => c.outcome === "drop").length;
		const totalCandidates = run.candidates.length;
		const reduction = run.rawTokens > 0 ? Math.round(((run.rawTokens - run.effectiveTokens) / run.rawTokens) * 100) : 0;
		const verb = isDry ? "Would drop" : "Dropped";

		const summaryLine = `${theme.fg(badgeColor, badgeText)} ${verb} ${droppedCount}/${totalCandidates} stale pairs · Context ~${formatTokens(run.effectiveTokens)} from ~${formatTokens(run.rawTokens)} (-${reduction}%)`;
		box.addChild(new Text(summaryLine, 0, 0));

		if (!expanded) {
			box.addChild(new Text(theme.fg("dim", "  (Ctrl+O to expand details)"), 0, 0));
			return box;
		}

		// Expanded details view
		const detailsContainer = new Container();
		detailsContainer.addChild(new Spacer(1));
		detailsContainer.addChild(new Text(theme.fg("muted", `  Run ID: ${run.id} · Timestamp: ${run.at}`), 0, 0));
		if (run.goal) {
			detailsContainer.addChild(new Text(theme.fg("dim", `  Goal: "${truncateToWidth(run.goal.replace(/\n/g, " "), 100, "...")}"`), 0, 0));
		}
		if (run.usage && run.usage.inputTokens > 0) {
			detailsContainer.addChild(
				new Text(theme.fg("dim", `  TypeSafe: ${run.usage.inputTokens} in / ${run.usage.outputTokens} out (${estimateCost(run.usage.inputTokens)}) · ${run.requestCount} req`), 0, 0),
			);
		}

		if (run.candidates.length > 0) {
			detailsContainer.addChild(new Spacer(1));
			detailsContainer.addChild(new Text(theme.bold("  #    ID                      Tool            Input Summary                             Size     p(keep)  Status"), 0, 0));
			detailsContainer.addChild(new DynamicBorder((s: string) => theme.fg("borderMuted", s)));

			run.candidates.forEach((cand, idx) => {
				const num = String(idx + 1).padStart(3, "0");
				const id = (cand.toolCallId.length > 22 ? cand.toolCallId.slice(0, 19) + "..." : cand.toolCallId).padEnd(22, " ");
				const tool = (cand.toolName.length > 14 ? cand.toolName.slice(0, 11) + "..." : cand.toolName).padEnd(14, " ");
				const input = truncateToWidth(cand.inputSummary.replace(/\n/g, " "), 40).padEnd(41, " ");
				const size = formatBytes(cand.resultChars).padStart(8, " ");
				const prob = cand.keepProbability.toFixed(2).padStart(7, " ");
				const status = cand.outcome === "drop" ? theme.fg("warning", "DROP") : theme.fg("success", "KEEP");
				detailsContainer.addChild(new Text(`  ${num}  ${theme.fg("muted", id)}  ${theme.fg("accent", tool)}  ${theme.fg("dim", input)} ${size} ${prob}   ${status}`, 0, 0));
			});
		}

		box.addChild(detailsContainer);
		return box;
	};
}

/**
 * Interactive TUI Context Modal Overlay.
 */
class ContextViewerComponent implements Component {
	private activeTab: "purged" | "context";
	private scrollOffset = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private messages: AgentMessage[];
	private activeDroppedIds: ReadonlySet<string>;
	private latestRun?: PersistedRun;
	private theme: any;
	private done: (value?: any) => void;
	private requestRender: () => void;

	constructor(options: {
		messages: AgentMessage[];
		activeDroppedIds: ReadonlySet<string>;
		latestRun?: PersistedRun;
		theme: any;
		done: (value?: any) => void;
		requestRender: () => void;
	}) {
		this.messages = options.messages;
		this.activeDroppedIds = options.activeDroppedIds;
		this.latestRun = options.latestRun;
		this.theme = options.theme;
		this.done = options.done;
		this.requestRender = options.requestRender;
		this.activeTab = (this.latestRun?.candidates.length ?? 0) > 0 ? "purged" : "context";
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
			this.done();
			return;
		}

		if (matchesKey(data, Key.tab)) {
			this.activeTab = this.activeTab === "purged" ? "context" : "purged";
			this.scrollOffset = 0;
			this.invalidate();
			this.requestRender();
			return;
		}

		if (matchesKey(data, Key.up) || data === "k") {
			if (this.scrollOffset > 0) {
				this.scrollOffset--;
				this.invalidate();
				this.requestRender();
			}
			return;
		}

		if (matchesKey(data, Key.down) || data === "j") {
			this.scrollOffset++;
			this.invalidate();
			this.requestRender();
			return;
		}

		if (
			matchesKey(data, Key.pageUp) ||
			matchesKey(data, Key.ctrl("u")) ||
			matchesKey(data, Key.ctrl("b")) ||
			data === "b" ||
			data === "u"
		) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 20);
			this.invalidate();
			this.requestRender();
			return;
		}

		if (
			matchesKey(data, Key.pageDown) ||
			matchesKey(data, Key.ctrl("d")) ||
			matchesKey(data, Key.ctrl("f")) ||
			data === "f" ||
			data === "d" ||
			data === " "
		) {
			this.scrollOffset += 20;
			this.invalidate();
			this.requestRender();
			return;
		}

		if (matchesKey(data, Key.home) || data === "g") {
			this.scrollOffset = 0;
			this.invalidate();
			this.requestRender();
			return;
		}

		if (matchesKey(data, Key.end) || data === "G") {
			this.scrollOffset = 999999;
			this.invalidate();
			this.requestRender();
			return;
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const theme = this.theme;

		// 1. Header with Tab Bar
		const isDry = this.latestRun?.mode === "dry";
		const tab1Label = isDry
			? ` 1. Latest Dry Run (${this.latestRun?.candidates.length ?? 0} evaluated) `
			: ` 1. Latest Run (${this.latestRun?.candidates.length ?? 0} candidates) `;
		const tab2Label = ` 2. Active Context (${this.messages.length} msgs · ${this.activeDroppedIds.size} purged) `;

		const tab1Styled = this.activeTab === "purged"
			? theme.bg("selectedBg", theme.bold(theme.fg("accent", tab1Label)))
			: theme.fg("muted", tab1Label);

		const tab2Styled = this.activeTab === "context"
			? theme.bg("selectedBg", theme.bold(theme.fg("accent", tab2Label)))
			: theme.fg("muted", tab2Label);

		const headerLine = ` ${tab1Styled}  ${tab2Styled}   ${theme.fg("dim", "[Tab: Switch • ↑↓/jk: Line • b/f or u/d: Page • g/G: Top/Bottom • Esc/q: Close]")}`;
		lines.push(truncateToWidth(headerLine, width));
		lines.push(truncateToWidth("─".repeat(width), width));

		// 2. Tab Content Lines
		const fixedHeaderLines: string[] = [];
		const scrollableContentLines: string[] = [];

		if (this.activeTab === "purged") {
			this.renderPurgedTab(fixedHeaderLines, scrollableContentLines, width);
		} else {
			this.renderContextTab(fixedHeaderLines, scrollableContentLines, width);
		}

		lines.push(...fixedHeaderLines);

		// 3. Scroll and Viewport Windowing
		const maxViewLines = Math.max(10, 28 - fixedHeaderLines.length);
		const maxOffset = Math.max(0, scrollableContentLines.length - maxViewLines);
		this.scrollOffset = Math.min(this.scrollOffset, maxOffset);

		const visibleSlice = scrollableContentLines.slice(this.scrollOffset, this.scrollOffset + maxViewLines);
		lines.push(...visibleSlice);

		// Fill empty space if short
		while (lines.length < 30) {
			lines.push("");
		}

		// 4. Footer info
		lines.push(truncateToWidth("─".repeat(width), width));
		const scrollPercent = scrollableContentLines.length > maxViewLines
			? ` · Scroll: ${Math.round((this.scrollOffset / maxOffset) * 100)}% (${this.scrollOffset + 1}-${Math.min(scrollableContentLines.length, this.scrollOffset + maxViewLines)}/${scrollableContentLines.length})`
			: "";
		const activeCount = this.activeDroppedIds.size;
		const footerText = ` ${theme.fg("accent", "Jev Context Viewer")} · Active dropped: ${activeCount}${scrollPercent}`;
		lines.push(truncateToWidth(footerText, width));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	private renderPurgedTab(fixedHeader: string[], scrollableRows: string[], width: number): void {
		const theme = this.theme;
		if (!this.latestRun || this.latestRun.candidates.length === 0) {
			scrollableRows.push("");
			scrollableRows.push(theme.fg("muted", "  No candidates recorded in latest run."));
			scrollableRows.push(theme.fg("dim", `  Active dropped in current session context: ${this.activeDroppedIds.size} pairs.`));
			scrollableRows.push(theme.fg("dim", "  Run /jev dry or /jev to evaluate stale tool calls."));
			return;
		}

		const isDry = this.latestRun.mode === "dry";
		const modeBadge = isDry
			? theme.fg("warning", `[DRY RUN - ${this.latestRun.candidates.length} evaluated, none applied]`)
			: theme.fg("success", `[APPLIED - ${this.activeDroppedIds.size} active prunes in context]`);

		fixedHeader.push(theme.fg("muted", `  Run ID: ${this.latestRun.id} · Timestamp: ${this.latestRun.at} · ${modeBadge}`));
		if (this.latestRun.goal) {
			fixedHeader.push(theme.fg("dim", `  Goal: "${truncateToWidth(this.latestRun.goal.replace(/\n/g, " "), width - 12, "...")}"`));
		}
		fixedHeader.push(theme.fg("dim", `  Active dropped in current session context: ${this.activeDroppedIds.size} pairs`));
		fixedHeader.push("");

		const idWidth = 24;
		const toolWidth = 14;
		const sizeWidth = 10;
		const probWidth = 8;
		const statusWidth = 12;
		const fixedTotal = 81;
		const inputWidth = Math.max(30, width - fixedTotal);

		const header = `  #    ID` + " ".repeat(idWidth - 2) + `Tool` + " ".repeat(toolWidth - 4) + `Input Summary` + " ".repeat(Math.max(0, inputWidth - 13)) + `  Orig Size  p(keep)  Status`;
		fixedHeader.push(theme.bold(header));
		fixedHeader.push(theme.fg("borderMuted", "  " + "─".repeat(Math.min(width - 4, header.length - 2))));

		this.latestRun.candidates.forEach((cand, idx) => {
			const num = String(idx + 1).padStart(3, "0");
			const id = (cand.toolCallId.length > idWidth ? cand.toolCallId.slice(0, idWidth - 3) + "..." : cand.toolCallId).padEnd(idWidth, " ");
			const tool = (cand.toolName.length > toolWidth ? cand.toolName.slice(0, toolWidth - 3) + "..." : cand.toolName).padEnd(toolWidth, " ");
			const input = truncateToWidth(cand.inputSummary.replace(/\n/g, " "), inputWidth).padEnd(inputWidth, " ");
			const size = formatBytes(cand.resultChars).padStart(sizeWidth, " ");
			const prob = cand.keepProbability.toFixed(2).padStart(probWidth, " ");
			const status = isDry
				? (cand.outcome === "drop" ? theme.fg("warning", "WOULD DROP  ") : theme.fg("success", "WOULD KEEP  "))
				: (cand.outcome === "drop" ? theme.fg("warning", "PURGED      ") : theme.fg("success", "KEPT        "));
			scrollableRows.push(`  ${num}  ${theme.fg("muted", id)}  ${theme.fg("accent", tool)}  ${theme.fg("dim", input)}  ${size} ${prob}  ${status}`);
		});
	}

	private renderContextTab(fixedHeader: string[], scrollableRows: string[], width: number): void {
		const theme = this.theme;
		const pruned = applyPrunes(this.messages, this.activeDroppedIds) || this.messages;

		fixedHeader.push(theme.fg("muted", `  Showing ${pruned.length} messages currently sent to model (${this.activeDroppedIds.size} pairs purged)`));
		fixedHeader.push("");

		pruned.forEach((msg, idx) => {
			const role = msg.role;
			const roleBadge = role === "user"
				? theme.fg("accent", theme.bold(`[User Message #${idx + 1}]`))
				: role === "assistant"
					? theme.fg("success", theme.bold(`[Assistant Message #${idx + 1}]`))
					: theme.fg("muted", theme.bold(`[Tool Result #${idx + 1}: ${(msg as any).toolName || ""}]`));

			scrollableRows.push(roleBadge);

			if ("content" in msg) {
				if (typeof msg.content === "string") {
					for (const line of msg.content.split("\n")) {
						scrollableRows.push(`  ${truncateToWidth(line, width - 4)}`);
					}
				} else if (Array.isArray(msg.content)) {
					for (const block of msg.content) {
						if (block.type === "text") {
							if (block.text.startsWith("[jev: purged")) {
								scrollableRows.push(`  ${theme.fg("warning", theme.bold(truncateToWidth(block.text, width - 4)))}`);
							} else {
								for (const line of block.text.split("\n")) {
									scrollableRows.push(`  ${truncateToWidth(line, width - 4)}`);
								}
							}
						} else if (block.type === "toolCall") {
							scrollableRows.push(`  ${theme.fg("accent", `[toolCall: ${block.name}]`)} ${theme.fg("dim", JSON.stringify(block.arguments))}`);
						} else if (block.type === "thinking") {
							scrollableRows.push(`  ${theme.fg("dim", `[thinking: ${truncateToWidth(block.thinking.replace(/\n/g, " "), width - 16, "...")}]`)}`);
						}
					}
				}
			} else if (msg.role === "bashExecution") {
				scrollableRows.push(`  $ ${truncateToWidth((msg as any).command || "", width - 6)}`);
				if ((msg as any).output) {
					for (const line of ((msg as any).output as string).split("\n")) {
						scrollableRows.push(`  ${truncateToWidth(line, width - 4)}`);
					}
				}
			}
			scrollableRows.push("");
		});
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

/**
 * Open the context viewer modal.
 */
export async function openContextViewer(
	ctx: ExtensionContext,
	messages: AgentMessage[],
	activeDroppedIds: ReadonlySet<string>,
	latestRun?: PersistedRun,
): Promise<void> {
	await ctx.ui.custom(
		(tui, theme, _keybindings, done) => {
			return new ContextViewerComponent({
				messages,
				activeDroppedIds,
				latestRun,
				theme,
				done,
				requestRender: () => tui.requestRender(),
			});
		},
		{
			overlay: true,
			overlayOptions: { width: "95%", maxHeight: "88%", anchor: "center" },
		},
	);
}
