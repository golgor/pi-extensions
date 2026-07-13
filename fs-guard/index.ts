/**
 * fs-guard — blocks or gates irrecoverable destructive bash commands.
 *
 * Scope (deliberately narrow, see AGENTS.md / CONTEXT.md for the full
 * rationale):
 *   - Only inspects the `bash` tool. `read` / `write` / `edit` and user-typed
 *     `!` commands are completely untouched.
 *   - "Full access, no friction" inside ALLOWED_ROOTS: the cwd Pi was
 *     started in, plus ~/Code/Work and ~/Code/Personal. Exception: if cwd
 *     is exactly $HOME or the filesystem root, it's too broad to auto-trust
 *     and is excluded (see isTooBroadToTrust).
 *   - Outside those roots (or when a target can't be confidently resolved),
 *     destructive commands are gated behind a confirmation prompt, and
 *     fail closed (blocked) when no UI is available to ask, or the user
 *     declines.
 *   - A small, fixed set of always-catastrophic commands (fork bombs,
 *     mkfs, dd of=/dev/*, wipefs, ...) are hard-blocked with no
 *     confirmation option at all.
 *
 * This is a best-effort heuristic over the raw command string, not a real
 * sandbox — see the "Known limitations" section in AGENTS.md.
 */

import { homedir } from "node:os";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

const HOME = homedir();

// Roots outside the launch cwd that get full, unrestricted bash access.
// The cwd Pi was started in is added dynamically per-call (ctx.cwd), unless
// it's too broad to auto-trust (see isTooBroadToTrust).
const STATIC_ALLOWED_ROOTS = [join(HOME, "Code", "Work"), join(HOME, "Code", "Personal")];

/**
 * Some cwd values are too broad to safely auto-trust, even though "the cwd
 * Pi was launched in" is otherwise always a trusted root. Launching Pi
 * directly from $HOME or the filesystem root would otherwise grant
 * unrestricted destructive-command access to effectively everything under
 * it. Any other specific working directory (e.g. /tmp/some-project) is
 * still trusted as before.
 */
function isTooBroadToTrust(resolvedCwd: string): boolean {
	return resolvedCwd === HOME || resolvedCwd === parse(resolvedCwd).root;
}

// Commands that are always blocked outright, regardless of target path.
// No confirmation is offered for these — they're catastrophic in
// essentially every real-world scenario.
const ALWAYS_BLOCK_PATTERNS: RegExp[] = [
	/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, // classic fork bomb
	/\bmkfs(\.\w+)?\b/,
	/\bdd\b[^\n]*\bof=\/dev\//,
	/\bwipefs\b/,
	/>\s*\/dev\/(sd|nvme|hd)\w*/,
	/\bchmod\b\s+-R\s+0*\s+\/(\s|$)/,
	/\bchown\b\s+-R\s+\S+\s+\/(\s|$)/,
];

// Deletion-family commands whose target paths get resolved and checked.
const DELETION_COMMANDS = new Set(["rm", "rmdir", "unlink", "shred"]);

const SYSTEM_PROMPT_NOTE = `

## Filesystem safety (fs-guard extension)
A local extension gates destructive bash commands (rm, rmdir, unlink, shred, git clean, find -delete, xargs+rm, dd/mkfs/wipefs, etc.). Commands targeting the current working directory, ~/Code/Work, or ~/Code/Personal run without friction. Commands targeting anywhere else require user confirmation and are blocked if no one can approve. Prefer literal paths for destructive commands instead of variables, command substitution, or globs — targets the extension can't confidently resolve are treated as unsafe and blocked automatically.`;

interface Escalation {
	reason: string;
}

/** Split a compound bash command into top-level simple commands on ; \n & && | ||. */
function splitTopLevelCommands(command: string): string[] {
	const parts: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];

		if (quote) {
			current += ch;
			if (ch === quote) quote = null;
			continue;
		}

		if (ch === "'" || ch === '"') {
			quote = ch;
			current += ch;
			continue;
		}

		if (ch === ";" || ch === "\n") {
			parts.push(current);
			current = "";
			continue;
		}

		if (ch === "&" || ch === "|") {
			if (command[i + 1] === ch) i++; // swallow && or ||
			parts.push(current);
			current = "";
			continue;
		}

		current += ch;
	}

	parts.push(current);
	return parts.map((p) => p.trim()).filter(Boolean);
}

/** Tokenize a simple command into words, respecting basic quoting. */
function tokenize(cmd: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let hasToken = false;

	for (let i = 0; i < cmd.length; i++) {
		const ch = cmd[i];

		if (quote) {
			if (ch === quote) quote = null;
			else current += ch;
			hasToken = true;
			continue;
		}

		if (ch === "'" || ch === '"') {
			quote = ch;
			hasToken = true;
			continue;
		}

		if (/\s/.test(ch)) {
			if (hasToken) {
				tokens.push(current);
				current = "";
				hasToken = false;
			}
			continue;
		}

		current += ch;
		hasToken = true;
	}

	if (hasToken) tokens.push(current);
	return tokens;
}

/** Skip leading `VAR=val` assignments and a leading `sudo [flags]`. */
function stripLeadingModifiers(tokens: string[]): string[] {
	let i = 0;
	while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
	while (i < tokens.length && tokens[i] === "sudo") {
		i++;
		while (i < tokens.length && tokens[i].startsWith("-")) i++;
	}
	return tokens.slice(i);
}

/** Resolve a candidate path argument. `ambiguous: true` means "can't safely verify". */
function resolveCandidate(pathArg: string, baseDir: string, trusted: boolean): { resolved?: string; ambiguous: boolean } {
	// Variables, command/process substitution, and globs can't be evaluated statically.
	if (/[$`*?]/.test(pathArg)) return { ambiguous: true };

	let expanded = pathArg;
	if (expanded === "~") expanded = HOME;
	else if (expanded.startsWith("~/")) expanded = join(HOME, expanded.slice(2));

	if (isAbsolute(expanded)) return { resolved: resolve(expanded), ambiguous: false };
	// Relative paths are only trustworthy if we know the effective cwd
	// (i.e. no earlier `cd` in the same compound command).
	if (!trusted) return { ambiguous: true };
	return { resolved: resolve(baseDir, expanded), ambiguous: false };
}

function isInsideAnyRoot(target: string, roots: string[]): boolean {
	return roots.some((root) => target === root || target.startsWith(root + sep));
}

/**
 * Walks a (possibly compound) bash command looking for deletion-family
 * operations whose target escapes the allowed roots, or can't be
 * confidently resolved. Returns null when the command is safe to run
 * without friction.
 */
function evaluateCommandForEscalation(command: string, cwd: string, allowedRoots: string[]): Escalation | null {
	let trusted = true; // becomes false once we pass an earlier `cd` in the chain

	for (const simple of splitTopLevelCommands(command)) {
		const tokens = stripLeadingModifiers(tokenize(simple));
		if (tokens.length === 0) continue;
		const head = tokens[0];

		if (head === "cd") {
			trusted = false;
			continue;
		}

		if (head === "xargs") {
			// The real targets come from piped stdin, which we can't inspect.
			const rest = tokens.slice(1).filter((t) => !t.startsWith("-"));
			const target = rest[0];
			if (target && (DELETION_COMMANDS.has(target) || (target === "git" && rest[1] === "clean"))) {
				return {
					reason: `\`xargs\` pipes into a deletion command ("${target}"); its targets come from piped input and can't be verified`,
				};
			}
			continue;
		}

		if (head === "find") {
			if (tokens.includes("-delete")) {
				const searchPath = tokens.slice(1).find((t) => !t.startsWith("-")) ?? ".";
				const { resolved, ambiguous } = resolveCandidate(searchPath, cwd, trusted);
				if (ambiguous || !resolved || !isInsideAnyRoot(resolved, allowedRoots)) {
					return { reason: `\`find ... -delete\` searches under "${searchPath}", which is outside the protected roots or unresolvable` };
				}
			}
			continue;
		}

		let kind: string | null = null;
		let args: string[] = [];
		if (head === "git" && tokens[1] === "clean") {
			kind = "git clean";
			args = tokens.slice(2);
		} else if (DELETION_COMMANDS.has(head)) {
			kind = head;
			args = tokens.slice(1);
		} else {
			continue;
		}

		const candidates = args.filter((a) => !a.startsWith("-"));
		const targets = candidates.length > 0 ? candidates : ["."]; // implicit target: cwd

		for (const raw of targets) {
			const { resolved, ambiguous } = resolveCandidate(raw, cwd, trusted);
			if (ambiguous || !resolved) {
				return {
					reason: `\`${kind}\` target "${raw}" could not be confidently resolved (variable, substitution, glob, or a prior 'cd' earlier in the same command)`,
				};
			}
			if (!isInsideAnyRoot(resolved, allowedRoots)) {
				return { reason: `\`${kind}\` targets "${resolved}", which is outside the protected roots` };
			}
		}
	}

	return null;
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		return { systemPrompt: event.systemPrompt + SYSTEM_PROMPT_NOTE };
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		const { command } = event.input;

		for (const pattern of ALWAYS_BLOCK_PATTERNS) {
			if (pattern.test(command)) {
				return {
					block: true,
					reason: `fs-guard: command matches an always-blocked destructive pattern and is never allowed, regardless of target.`,
				};
			}
		}

		const resolvedCwd = resolve(ctx.cwd);
		const allowedRoots = isTooBroadToTrust(resolvedCwd) ? [...STATIC_ALLOWED_ROOTS] : [resolvedCwd, ...STATIC_ALLOWED_ROOTS];
		const escalation = evaluateCommandForEscalation(command, ctx.cwd, allowedRoots);
		if (!escalation) return; // fully inside allowed roots, no friction

		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `fs-guard: blocked destructive command with no UI available to confirm. ${escalation.reason}. Protected roots: ${allowedRoots.join(", ")}`,
			};
		}

		const approved = await ctx.ui.confirm(
			"fs-guard: destructive command outside protected roots",
			`${escalation.reason}\n\nCommand:\n${command}\n\nProtected roots:\n${allowedRoots.join("\n")}`,
		);

		if (!approved) {
			return {
				block: true,
				reason: `fs-guard: user declined to approve destructive command outside protected roots. ${escalation.reason}`,
			};
		}
		// approved: fall through (no return) to let the command run.
	});
}
