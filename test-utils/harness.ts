/**
 * Shared test helpers for exercising a Pi extension's `default` factory
 * function outside of Pi itself.
 *
 * Every extension in this repo registers event handlers via
 * `pi.on(event, handler)`. To test one, we hand the factory a minimal fake
 * `ExtensionAPI` that just records handlers, then invoke the recorded
 * handler directly with a synthetic event + context. This exercises the
 * real extension code (no mocking of the logic under test), while staying
 * decoupled from Pi's own runtime.
 *
 * Usage in an extension's test file:
 *
 *   import { mountExtension, makeBashToolCallEvent, makeContext } from "../test-utils/harness";
 *   import fsGuard from "./index";
 *
 *   const { handlers } = await mountExtension(fsGuard);
 *   const result = await handlers.tool_call?.(
 *     makeBashToolCallEvent("rm -rf /tmp/x"),
 *     makeContext({ cwd: "/tmp" }),
 *   );
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

// biome-ignore lint/suspicious/noExplicitAny: handlers accept whatever event/result shape their event type uses
type AnyHandler = (event: any, ctx: ExtensionContext) => unknown | Promise<unknown>;

// biome-ignore lint/suspicious/noExplicitAny: command handlers accept whatever ctx shape the command needs
type AnyCommandHandler = (args: string, ctx: any) => unknown | Promise<unknown>;

export interface MountedExtension {
	/** Event handlers registered by the extension, keyed by event name. */
	handlers: Record<string, AnyHandler>;
	/** Slash-command handlers registered via `pi.registerCommand`, keyed by name. */
	commands: Record<string, AnyCommandHandler>;
	/** Argument-completion providers registered per command, keyed by name. */
	commandCompletions: Record<string, (prefix: string) => any>;
	/** Extension-owned custom entries appended during the test. */
	appendedEntries: Array<{ customType: string; data: unknown }>;
	/** Custom entry renderers registered via `pi.registerEntryRenderer`. */
	entryRenderers: Record<string, (entry: any, options: { expanded: boolean }, theme: any) => any>;
}

/**
 * Runs an extension's factory function against a fake ExtensionAPI that
 * implements `pi.on(...)` and `pi.registerCommand(...)`. Pass `extras` to
 * supply further ExtensionAPI members an extension under test calls (e.g. a
 * fake `exec` for extensions that shell out). Extend this if a future
 * extension under test needs yet more.
 */
export async function mountExtension(
	factory: (pi: ExtensionAPI) => void | Promise<void>,
	extras: Partial<ExtensionAPI> = {},
): Promise<MountedExtension> {
	const handlers: Record<string, AnyHandler> = {};
	const commands: Record<string, AnyCommandHandler> = {};
	const commandCompletions: Record<string, (prefix: string) => any> = {};
	const appendedEntries: Array<{ customType: string; data: unknown }> = [];
	const entryRenderers: Record<string, (entry: any, options: { expanded: boolean }, theme: any) => any> = {};

	const fakePi = {
		on(event: string, handler: AnyHandler) {
			handlers[event] = handler;
		},
		registerCommand(name: string, options: { handler: AnyCommandHandler; getArgumentCompletions?: (prefix: string) => any }) {
			commands[name] = options.handler;
			if (options.getArgumentCompletions) commandCompletions[name] = options.getArgumentCompletions;
		},
		appendEntry(customType: string, data: unknown) {
			appendedEntries.push({ customType, data });
		},
		registerEntryRenderer(customType: string, renderer: any) {
			entryRenderers[customType] = renderer;
		},
		...extras,
	} as unknown as ExtensionAPI;

	await factory(fakePi);
	return { handlers, commands, commandCompletions, appendedEntries, entryRenderers };
}

/** Builds a fake `pi.exec` from a matcher: return stdout for a given command+args, or throw/undefined. */
export function makeExec(
	respond: (command: string, args: string[]) => string | undefined,
): ExtensionAPI["exec"] {
	return (async (command: string, args: string[]) => {
		const stdout = respond(command, args);
		if (stdout === undefined) {
			return { stdout: "", stderr: `no fixture for: ${command} ${args.join(" ")}`, code: 1, killed: false };
		}
		return { stdout, stderr: "", code: 0, killed: false };
	}) as ExtensionAPI["exec"];
}

/** Builds a synthetic `tool_call` event for the `bash` tool. */
export function makeBashToolCallEvent(command: string, timeout?: number) {
	return {
		type: "tool_call" as const,
		toolName: "bash" as const,
		toolCallId: "test-call-id",
		input: { command, timeout },
	};
}

export interface FakeContextOptions {
	cwd: string;
	/** Whether a UI is available to answer `ctx.ui.confirm(...)`. Default: true. */
	hasUI?: boolean;
	/** What `ctx.ui.confirm(...)` resolves to when a UI is available. Default: true. */
	confirm?: boolean;
	/** Active branch entries exposed through the read-only session manager. */
	entries?: SessionEntry[];
	/** Active model context window used by compaction handlers. Default: 128k. */
	contextWindow?: number;
	/** Current raw context token estimate. */
	contextTokens?: number | null;
	/** Captures status/footer values set by an extension. */
	statuses?: Map<string, string | undefined>;
	/** Captures UI notifications emitted by an extension. */
	notifications?: Array<{ message: string; type: string | undefined }>;
	/** Mock handler for ctx.ui.custom components. */
	onCustomUI?: (factory: Function, options?: any) => any;
}

/** Builds a minimal fake `ExtensionContext` with branch-backed session reads. */
export function makeContext(options: FakeContextOptions): ExtensionContext {
	const {
		cwd,
		hasUI = true,
		confirm = true,
		entries = [],
		contextWindow = 128_000,
		contextTokens = null,
		statuses = new Map(),
		notifications = [],
		onCustomUI,
	} = options;

	const theme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		dim: (text: string) => text,
		italic: (text: string) => text,
	};

	return {
		cwd,
		hasUI,
		mode: "tui",
		model: { contextWindow },
		getContextUsage: () => ({ tokens: contextTokens, contextWindow, percent: null }),
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => entries,
			getLeafId: () => entries.at(-1)?.id ?? null,
		},
		ui: {
			theme,
			confirm: async () => confirm,
			notify: (message: string, type?: string) => notifications.push({ message, type }),
			setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
			custom: async (factoryOrOptions: any, maybeOptions?: any) => {
				const factory = typeof factoryOrOptions === "function" ? factoryOrOptions : maybeOptions;
				const opts = typeof factoryOrOptions === "function" ? maybeOptions : factoryOrOptions;
				if (onCustomUI) return onCustomUI(factory, opts);
				let result: any;
				const done = (val: any) => { result = val; };
				const tui = { requestRender: () => {} };
				const keybindings = {};
				const comp = factory(tui, theme, keybindings, done);
				return result ?? comp;
			},
		},
	} as unknown as ExtensionContext;
}
