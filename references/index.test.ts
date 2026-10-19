/**
 * Behavioral tests for references. The built-in `@` provider is replaced by a
 * fake that returns a fixed file match, so the tests pin down how references
 * merge with (and defer to) it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { makeContext, mountExtension } from "../test-utils/harness";
import references from "./index";

const FILE_MATCH = { value: "@docs/notes.md", label: "notes.md", description: "docs/notes.md" };

const builtIn: AutocompleteProvider = {
	async getSuggestions(lines, line, col) {
		const before = (lines[line] ?? "").slice(0, col);
		const match = before.match(/@\S*$/);
		return match ? { prefix: match[0], items: [FILE_MATCH] } : null;
	},
	applyCompletion(lines, line, col, item, prefix) {
		const text = lines[line] ?? "";
		const next = text.slice(0, col - prefix.length) + item.value + text.slice(col);
		return { lines: [next], cursorLine: line, cursorCol: col - prefix.length + item.value.length };
	},
};

let agentDir: string;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "references-test-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

async function start(config?: string) {
	if (config !== undefined) writeFileSync(join(agentDir, "references.json"), config);
	const providers: Parameters<typeof makeContext>[0]["autocompleteProviders"] = [];
	const notifications: Array<{ message: string; type: string | undefined }> = [];
	const { handlers } = await mountExtension(references);
	await handlers.session_start?.({ type: "session_start" }, makeContext({ cwd: "/tmp", autocompleteProviders: providers, notifications }));
	const provider = providers[0]?.(builtIn);
	return { provider, providers, notifications };
}

function suggest(provider: AutocompleteProvider, text: string) {
	return provider.getSuggestions([text], 0, text.length, { signal: new AbortController().signal });
}

const CONFIG = JSON.stringify({
	dotfiles: { path: "~/.dotfiles", description: "Personal dotfiles repository" },
	config: { path: "~/.config/", description: "User-level application configuration" },
});

describe("references: suggestions", () => {
	test("bare @ lists every reference before the built-in file matches", async () => {
		const { provider } = await start(CONFIG);
		const result = await suggest(provider!, "look at @");
		expect(result?.prefix).toBe("@");
		expect(result?.items.map((i) => i.label)).toEqual(["dotfiles/", "config/", "notes.md"]);
	});

	test("@token fuzzy-filters references by name", async () => {
		const { provider } = await start(CONFIG);
		const result = await suggest(provider!, "@dotf");
		expect(result?.items[0]).toEqual({
			value: "@~/.dotfiles/",
			label: "dotfiles/",
			description: "Personal dotfiles repository (~/.dotfiles)",
		});
		expect(result?.items.map((i) => i.label)).not.toContain("config/");
	});

	test("matches against the description too", async () => {
		const { provider } = await start(CONFIG);
		const result = await suggest(provider!, "@application");
		expect(result?.items[0]?.label).toBe("config/");
	});

	test("a token containing / is left to the built-in provider", async () => {
		const { provider } = await start(CONFIG);
		const result = await suggest(provider!, "@~/.dotfiles/nv");
		expect(result?.items).toEqual([FILE_MATCH]);
	});

	test("no reference match falls back to the built-in result unchanged", async () => {
		const { provider } = await start(CONFIG);
		const result = await suggest(provider!, "@zzzzqq");
		expect(result?.items).toEqual([FILE_MATCH]);
	});

	test("an @ inside a word (e.g. an email) does not trigger references", async () => {
		const { provider } = await start(CONFIG);
		const result = await suggest(provider!, "mail me@dot");
		expect(result?.items).toEqual([FILE_MATCH]);
	});

	test("applying a reference inserts its real path, ready for further completion", async () => {
		const { provider } = await start(CONFIG);
		const result = await suggest(provider!, "see @dot");
		const applied = provider!.applyCompletion(["see @dot"], 0, 8, result!.items[0]!, result!.prefix);
		expect(applied.lines[0]).toBe("see @~/.dotfiles/");
	});
});

describe("references: config file", () => {
	test("a missing file registers nothing and stays silent", async () => {
		const { providers, notifications } = await start();
		expect(providers).toHaveLength(0);
		expect(notifications).toHaveLength(0);
	});

	test("invalid JSON is reported and registers nothing", async () => {
		const { providers, notifications } = await start("{ not json");
		expect(providers).toHaveLength(0);
		expect(notifications[0]?.message).toContain("invalid JSON");
		expect(notifications[0]?.type).toBe("error");
	});

	test("a reference without a path is reported", async () => {
		const { providers, notifications } = await start(JSON.stringify({ broken: { description: "no path" } }));
		expect(providers).toHaveLength(0);
		expect(notifications[0]?.message).toContain('"broken"');
	});
});
