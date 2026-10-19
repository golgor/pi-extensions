/**
 * references — named shortcuts to often-used directories in `@` completion,
 * modelled on OpenCode's "references".
 *
 * Config: `<agent dir>/references.json` (normally ~/.pi/agent/references.json):
 *
 *   { "dotfiles": { "path": "~/.dotfiles", "description": "Personal dotfiles" } }
 *
 * Typing `@dot` lists matching references above the built-in file matches.
 * Picking one inserts the real path (`@~/.dotfiles/`), so the prompt only
 * ever holds paths the model and tools understand, and the built-in provider
 * takes over completion inside that directory.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, type AutocompleteProvider, fuzzyFilter } from "@earendil-works/pi-tui";

interface Reference {
	name: string;
	path: string;
	description?: string;
}

/** Returns the references, `[]` when the file is absent, or an error message when it is malformed. */
function loadReferences(file: string): Reference[] | string {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		return `cannot read ${file}: ${(error as Error).message}`;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return `invalid JSON in ${file}: ${(error as Error).message}`;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return `${file} must be an object of name → { path, description }`;
	}

	const references: Reference[] = [];
	for (const [name, value] of Object.entries(parsed)) {
		const path = (value as { path?: unknown })?.path;
		if (typeof path !== "string" || path === "") {
			return `reference "${name}" in ${file} needs a non-empty "path" string`;
		}
		const description = (value as { description?: unknown }).description;
		references.push({ name, path, description: typeof description === "string" ? description : undefined });
	}
	return references;
}

function toItem(reference: Reference): AutocompleteItem {
	const path = reference.path.endsWith("/") ? reference.path : `${reference.path}/`;
	return {
		value: `@${path}`,
		// The trailing "/" tells the built-in applyCompletion this is a directory:
		// no space is appended, so completion can continue inside it.
		label: `${reference.name}/`,
		description: reference.description ? `${reference.description} (${reference.path})` : reference.path,
	};
}

function createProvider(current: AutocompleteProvider, references: Reference[]): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const builtIn = await current.getSuggestions(lines, cursorLine, cursorCol, options);

			// Only a bare `@name` token: once it holds a "/" (or a quote) the user is
			// already inside a path and the built-in provider owns completion.
			const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
			const match = beforeCursor.match(/(?:^|\s)@([^\s/"]*)$/);
			if (!match) return builtIn;

			const query = match[1] ?? "";
			const items = fuzzyFilter(references, query, (r) => `${r.name} ${r.description ?? ""}`).map(toItem);
			if (items.length === 0) return builtIn;

			return { prefix: `@${query}`, items: [...items, ...(builtIn?.items ?? [])] };
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		const file = join(getAgentDir(), "references.json");
		const references = loadReferences(file);
		if (typeof references === "string") {
			ctx.ui.notify(`references: ${references}`, "error");
			return;
		}
		if (references.length === 0) return;
		ctx.ui.addAutocompleteProvider((current) => createProvider(current, references));
	});
}
