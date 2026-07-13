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

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// biome-ignore lint/suspicious/noExplicitAny: handlers accept whatever event/result shape their event type uses
type AnyHandler = (event: any, ctx: ExtensionContext) => unknown | Promise<unknown>;

export interface MountedExtension {
	/** Event handlers registered by the extension, keyed by event name. */
	handlers: Record<string, AnyHandler>;
}

/**
 * Runs an extension's factory function against a fake ExtensionAPI that
 * only implements `pi.on(...)`. Sufficient for extensions (like fs-guard)
 * that don't register tools/commands/shortcuts. Extend this if a future
 * extension under test also needs those.
 */
export async function mountExtension(factory: (pi: ExtensionAPI) => void | Promise<void>): Promise<MountedExtension> {
	const handlers: Record<string, AnyHandler> = {};

	const fakePi = {
		on(event: string, handler: AnyHandler) {
			handlers[event] = handler;
		},
	} as unknown as ExtensionAPI;

	await factory(fakePi);
	return { handlers };
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
}

/** Builds a minimal fake `ExtensionContext` sufficient for testing tool_call handlers. */
export function makeContext(options: FakeContextOptions): ExtensionContext {
	const { cwd, hasUI = true, confirm = true } = options;
	return {
		cwd,
		hasUI,
		ui: {
			confirm: async () => confirm,
			notify: () => {},
		},
	} as unknown as ExtensionContext;
}
