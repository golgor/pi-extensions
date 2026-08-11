/**
 * wayfinder-map — /map renders the current repo's wayfinder map (GitHub
 * issues tracker) as a browser star-map.
 *
 * The frontend under web/ is vendored verbatim from rengwu/wayfinder-maps
 * (MIT — see web/LICENSE and CONTEXT.md). This file only implements the
 * small JSON API that frontend already speaks, backed by `gh` calls that
 * run in the session cwd, so the repo is always "the folder Pi is in".
 *
 * Refresh model: /api/graph re-derives the whole graph from GitHub on every
 * request (F5 = refresh); /api/version returns a constant so the frontend's
 * live-reload poller never fires.
 */

import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const WEB_DIR = fileURLToPath(new URL("./web", import.meta.url));

/**
 * Injected into the vendored index.html at serve time (web/ stays verbatim —
 * see CONTEXT.md). Shows a loading label until the first /api/graph settles;
 * the inline classic script runs before the frontend's deferred module
 * scripts, so the fetch hook is in place before any request is made.
 *
 * The CSS rule hides the "← Maps" button and the splash/maplist screens: this
 * extension serves exactly one map per /map invocation, and those screens
 * dead-end on stub endpoints (folder picking makes no sense against GitHub).
 */
const LOADING_OVERLAY = `<style>#backbtn,#splash,#maplist{display:none !important}</style>
<div id="wfm-loading" style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;color:#c8ccd6;font:14px system-ui;pointer-events:none;z-index:99">Fetching map from GitHub…</div>
<script>(function(){
  var f = window.fetch;
  window.fetch = function(input){
    var p = f.apply(this, arguments);
    var url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.indexOf("/api/graph") !== -1) p.then(function(r){
      var e = document.getElementById("wfm-loading"); if (!e) return;
      if (r.ok) e.remove(); else e.textContent = "Map fetch failed (HTTP " + r.status + ") — see devtools network tab";
    }, function(){ var e = document.getElementById("wfm-loading"); if (e) e.textContent = "Map fetch failed — see devtools network tab"; });
    return p;
  };
})();</script>`;

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
};

// --- GitHub shapes (the subset we read) -----------------------------------

interface GhIssue {
	number: number;
	title: string;
	state: string; // "open" | "closed" (REST lowercases)
	state_reason?: string | null; // "completed" | "not_planned" | ...
	body?: string | null;
	assignees?: { login: string }[];
	labels?: { name: string }[];
}

// --- graphDoc (the contract the vendored frontend consumes) ---------------

interface NodeDoc {
	num: number;
	title: string;
	type: string;
	status: "resolved" | "claimed" | "frontier" | "blocked" | "out_of_scope";
	rank: number;
	undermined: boolean;
	claimedBy?: string;
	blockers: number[];
	body: string;
}

interface GraphDoc {
	name: string;
	destination: string;
	counts: { resolved: number; claimed: number; open: number; outOfScope: number; total: number };
	nodes: NodeDoc[];
	edges: { from: number; to: number; satisfied: boolean }[];
	fog: { title: string; clearsWith: number }[];
}

// --- pure derivation helpers -----------------------------------------------

/** Text of one `## Heading` section of a markdown body (until the next `## `). */
function sectionOf(body: string, heading: string): string {
	const m = body.match(new RegExp(`^##\\s+${heading}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, "mi"));
	return m ? m[1].trim() : "";
}

/** Fallback edge source: a `Blocked by: #12, #34` line near the top of a body. */
function parseBlockedByLine(body: string): number[] {
	const m = (body ?? "").match(/^\s*Blocked by:\s*(.+)$/im);
	if (!m) return [];
	return [...m[1].matchAll(/#?(\d+)/g)].map((x) => Number(x[1]));
}

/** Fog patches from the map's `## Not yet specified` bullets. */
function parseFog(mapBody: string): { title: string; clearsWith: number }[] {
	const section = sectionOf(mapBody, "Not yet specified");
	const fog: { title: string; clearsWith: number }[] = [];
	for (const line of section.split("\n")) {
		const bullet = line.match(/^\s*[-*]\s+(.*)$/);
		if (!bullet) continue;
		const bold = bullet[1].match(/\*\*(.+?)\*\*/);
		const title = (bold ? bold[1] : bullet[1].split(".")[0]).replace(/\.\s*$/, "").trim();
		const clears = bullet[1].match(/<clears-with:\s*#?(\d+)>/i);
		fog.push({ title, clearsWith: clears ? Number(clears[1]) : 0 });
	}
	return fog;
}

/**
 * Dependency depth per node: a ticket's rank is one past its deepest blocker.
 * Ported from chartr's starmap layout (MIT, same upstream author).
 */
function rankOf(nodes: { num: number; blockers: number[] }[]): Record<number, number> {
	const rank: Record<number, number> = {};
	for (const n of nodes) rank[n.num] = 0;
	for (let pass = 0; pass < nodes.length; pass++) {
		for (const n of nodes) {
			for (const b of n.blockers) {
				if (rank[b] === undefined) continue;
				if (rank[n.num] < rank[b] + 1) rank[n.num] = rank[b] + 1;
			}
		}
	}
	return rank;
}

function isClosed(state: string): boolean {
	return state.toLowerCase() === "closed";
}

/**
 * Build the graphDoc from the map issue, its sub-issues, and each child's
 * blocker issues (number + state), keyed by child number.
 */
function buildGraphDoc(
	map: GhIssue,
	children: GhIssue[],
	blockersOf: Record<number, { number: number; state: string }[]>,
): GraphDoc {
	const present = new Set(children.map((c) => c.number));
	const stateOf: Record<number, string> = {};
	for (const c of children) stateOf[c.number] = c.state;

	const raw = children.map((c) => {
		// Native dependencies first; the tracker doc's body-line fallback when
		// the API gave nothing. Blocker state falls back to the sibling's state.
		let blockers = (blockersOf[c.number] ?? []).filter((b) => present.has(b.number));
		if (blockers.length === 0) {
			blockers = parseBlockedByLine(c.body ?? "")
				.filter((n) => present.has(n))
				.map((n) => ({ number: n, state: stateOf[n] }));
		}
		return { child: c, blockers };
	});

	const rank = rankOf(raw.map((r) => ({ num: r.child.number, blockers: r.blockers.map((b) => b.number) })));

	const counts = { resolved: 0, claimed: 0, open: 0, outOfScope: 0, total: children.length };
	const nodes: NodeDoc[] = [];
	const edges: GraphDoc["edges"] = [];

	for (const { child, blockers } of raw) {
		let status: NodeDoc["status"];
		if (isClosed(child.state)) {
			status = child.state_reason === "not_planned" ? "out_of_scope" : "resolved";
		} else if ((child.assignees ?? []).length > 0) {
			status = "claimed";
		} else if (blockers.every((b) => isClosed(b.state))) {
			status = "frontier";
		} else {
			status = "blocked";
		}
		if (status === "resolved") counts.resolved++;
		else if (status === "claimed") counts.claimed++;
		else if (status === "out_of_scope") counts.outOfScope++;
		else counts.open++;

		const typeLabel = (child.labels ?? []).find((l) => l.name.startsWith("wayfinder:") && l.name !== "wayfinder:map");
		nodes.push({
			num: child.number,
			title: child.title,
			type: typeLabel ? typeLabel.name.slice("wayfinder:".length) : "",
			status,
			rank: rank[child.number] ?? 0,
			undermined: false, // no GitHub representation
			...((child.assignees ?? []).length > 0 ? { claimedBy: child.assignees?.[0]?.login } : {}),
			blockers: blockers.map((b) => b.number),
			body: child.body ?? "",
		});
		for (const b of blockers) edges.push({ from: b.number, to: child.number, satisfied: isClosed(b.state) });
	}

	return {
		name: map.title,
		destination: sectionOf(map.body ?? "", "Destination"),
		counts,
		nodes,
		edges,
		fog: parseFog(map.body ?? ""),
	};
}

// --- extension --------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let server: Server | undefined;
	let port = 0;
	// Set by /map; read by /api/initial and /api/graph.
	let cwd = "";
	let mapNumber = 0;

	async function gh(args: string[]): Promise<string> {
		const r = await pi.exec("gh", args, { cwd, timeout: 30_000 });
		if (r.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")}: ${(r.stderr || r.stdout).trim()}`);
		return r.stdout;
	}

	async function fetchGraph(effort: number): Promise<GraphDoc> {
		const repo = JSON.parse(await gh(["repo", "view", "--json", "nameWithOwner"])).nameWithOwner as string;
		const map: GhIssue = JSON.parse(await gh(["api", `repos/${repo}/issues/${effort}`]));
		// ponytail: per_page=100, no pagination — paginate if a map outgrows 100 tickets
		// per_page goes in the path: `gh api -F` would switch the request to POST
		const children: GhIssue[] = JSON.parse(await gh(["api", `repos/${repo}/issues/${effort}/sub_issues?per_page=100`]));
		const blockersOf: Record<number, { number: number; state: string }[]> = {};
		// ponytail: N+1 gh calls, one per child (in parallel) — single GraphQL query if maps get big
		await Promise.all(
			children.map(async (c) => {
				try {
					const deps: GhIssue[] = JSON.parse(await gh(["api", `repos/${repo}/issues/${c.number}/dependencies/blocked_by?per_page=100`]));
					blockersOf[c.number] = deps.map((d) => ({ number: d.number, state: d.state }));
				} catch {
					blockersOf[c.number] = []; // buildGraphDoc falls back to the body line
				}
			}),
		);
		return buildGraphDoc(map, children, blockersOf);
	}

	function startServer(): Promise<number> {
		return new Promise((resolvePort, reject) => {
			server = createServer(async (req, res) => {
				const path = new URL(req.url ?? "/", "http://localhost").pathname;
				const send = (code: number, type: string, body: string | Buffer) => {
					res.writeHead(code, { "Content-Type": type });
					res.end(body);
				};
				const json = (data: unknown) => send(200, "application/json", JSON.stringify(data));
				try {
					if (path === "/api/initial") return json({ effort: String(mapNumber) });
					if (path === "/api/version") return send(200, "text/plain", "0");
					if (path === "/api/graph") {
						const effort = Number(new URL(req.url ?? "/", "http://localhost").searchParams.get("effort")) || mapNumber;
						return json(await fetchGraph(effort));
					}
					if (path === "/api/pick") return json({});
					if (path === "/api/maps" || path === "/api/recents") return json([]);
					if (path.startsWith("/api/")) return json({});
					if (path === "/favicon.ico") {
						res.writeHead(204);
						return res.end();
					}
					// static files from the vendored web/
					const rel = path === "/" ? "index.html" : normalize(path).replace(/^[/\\]+/, "");
					if (rel.split(/[/\\]/).includes("..")) return send(403, "text/plain", "forbidden");
					try {
						const data = await readFile(join(WEB_DIR, rel));
						if (rel === "index.html") {
							return send(200, MIME[".html"], data.toString().replace("</body>", `${LOADING_OVERLAY}\n</body>`));
						}
						return send(200, MIME[extname(rel)] ?? "application/octet-stream", data);
					} catch {
						return send(404, "text/plain", "not found");
					}
				} catch (err) {
					return send(500, "text/plain", err instanceof Error ? err.message : String(err));
				}
			});
			server.on("error", reject);
			server.listen(0, "127.0.0.1", () => {
				const addr = server?.address();
				resolvePort(typeof addr === "object" && addr ? addr.port : 0);
			});
		});
	}

	pi.registerCommand("map", {
		description: "Open this repo's wayfinder map as a browser star-map",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			cwd = ctx.cwd;
			let maps: { number: number; title: string }[];
			try {
				maps = JSON.parse(
					await gh(["issue", "list", "--label", "wayfinder:map", "--state", "all", "--json", "number,title", "--limit", "50"]),
				);
			} catch (err) {
				ctx.ui.notify(`Not a GitHub repo, or gh unavailable: ${err instanceof Error ? err.message : err}`, "error");
				return;
			}
			if (maps.length === 0) {
				ctx.ui.notify("No wayfinder:map issue in this repo", "info");
				return;
			}
			let chosen = maps[0];
			if (maps.length > 1) {
				const labels = maps.map((m) => `#${m.number} ${m.title}`);
				const pick = await ctx.ui.select("Which map?", labels);
				if (pick === undefined) return;
				chosen = maps[labels.indexOf(pick)];
			}
			mapNumber = chosen.number;
			if (!server) port = await startServer();
			const url = `http://127.0.0.1:${port}/`;
			await pi.exec("xdg-open", [url], { cwd });
			ctx.ui.notify(`Star-map: ${url}`, "info");
		},
	});

	pi.on("session_shutdown", () => {
		server?.close();
		server = undefined;
	});
}
