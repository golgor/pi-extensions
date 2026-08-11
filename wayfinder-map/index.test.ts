/**
 * Behavioral tests for wayfinder-map. These exercise the real `/map`
 * command handler and the loopback HTTP server it starts, with a fake
 * `pi.exec` answering every `gh` call from fixtures — see CONTEXT.md for
 * the status-derivation table and edge-fallback rules asserted here.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { makeExec, mountExtension, type MountedExtension } from "../test-utils/harness";
import wayfinderMap from "./index";

const MAP_BODY = [
	"## Destination",
	"",
	"A spec for the timeline feature.",
	"",
	"## Not yet specified",
	"",
	"- **Today's row.** Whether today is visually distinguished. <clears-with: #13>",
	"- **Error states.** What a failed load looks like.",
	"",
	"## Decisions so far",
	"",
	"- something already decided",
].join("\n");

const MAP_ISSUE = { number: 1, title: "My Map", state: "open", body: MAP_BODY };

// One child per status in the derivation table, plus the body-line fallback:
//   #10 closed+completed            -> resolved
//   #11 closed+not_planned          -> out_of_scope
//   #12 open+assignee               -> claimed
//   #13 open, blocker #10 closed    -> frontier   (rank 1, satisfied edge)
//   #14 open, blocker #12 open      -> blocked    (rank 1, unsatisfied edge)
//   #15 open, deps API fails, body "Blocked by: #13" -> blocked via fallback (rank 2)
const CHILDREN = [
	{
		number: 10,
		title: "Pick the data model",
		state: "closed",
		state_reason: "completed",
		body: "## Question\nWhich model?",
		labels: [{ name: "wayfinder:grilling" }],
	},
	{
		number: 11,
		title: "Support IE11",
		state: "closed",
		state_reason: "not_planned",
		body: "",
		labels: [{ name: "wayfinder:research" }],
	},
	{
		number: 12,
		title: "Window size",
		state: "open",
		assignees: [{ login: "golgor" }],
		body: "",
		labels: [{ name: "wayfinder:grilling" }],
	},
	{
		number: 13,
		title: "Today's row rendering",
		state: "open",
		body: "",
		labels: [{ name: "wayfinder:prototype" }],
	},
	{
		number: 14,
		title: "Infinite scroll contract",
		state: "open",
		body: "",
		labels: [{ name: "wayfinder:grilling" }],
	},
	{
		number: 15,
		title: "Test strategy",
		state: "open",
		body: "Blocked by: #13\n\n## Question\nHow to test?",
		labels: [{ name: "wayfinder:task" }],
	},
];

const BLOCKERS: Record<number, { number: number; state: string }[] | undefined> = {
	10: [],
	11: [],
	12: [],
	13: [{ number: 10, state: "closed" }],
	14: [{ number: 12, state: "open" }],
	15: undefined, // dependencies API fails for this one -> body-line fallback
};

/** Fake `pi.exec` answering the gh calls the extension makes, capturing xdg-open URLs. */
function makeGhExec(openedUrls: string[], maps = [{ number: 1, title: "My Map" }]) {
	return makeExec((command, args) => {
		if (command === "xdg-open") {
			openedUrls.push(args[0]);
			return "";
		}
		if (command !== "gh") return undefined;
		if (args[0] === "issue" && args[1] === "list") return JSON.stringify(maps);
		if (args[0] === "repo" && args[1] === "view") return JSON.stringify({ nameWithOwner: "o/r" });
		if (args[0] === "api") {
			// Real `gh api -F ...` switches the request to POST (a live bug once shipped
			// this way) — query params must ride in the path, so reject -F outright.
			if (args.includes("-F")) return undefined;
			const path = args[1];
			if (path === "repos/o/r/issues/1") return JSON.stringify(MAP_ISSUE);
			if (path === "repos/o/r/issues/1/sub_issues?per_page=100") return JSON.stringify(CHILDREN);
			const dep = path.match(/^repos\/o\/r\/issues\/(\d+)\/dependencies\/blocked_by\?per_page=100$/);
			if (dep) {
				const blockers = BLOCKERS[Number(dep[1])];
				return blockers === undefined ? undefined : JSON.stringify(blockers);
			}
		}
		return undefined;
	});
}

function makeCommandContext(notifications: string[]) {
	return {
		cwd: "/tmp/some-repo",
		ui: {
			notify: (msg: string) => notifications.push(msg),
			select: async () => undefined,
		},
	};
}

/** Mounts the extension, runs /map, and returns the served base URL. */
async function openMap(): Promise<{ mounted: MountedExtension; baseUrl: string; notifications: string[] }> {
	const openedUrls: string[] = [];
	const notifications: string[] = [];
	const mounted = await mountExtension(wayfinderMap, { exec: makeGhExec(openedUrls) });
	await mounted.commands.map?.("", makeCommandContext(notifications));
	expect(openedUrls).toHaveLength(1);
	return { mounted, baseUrl: openedUrls[0].replace(/\/$/, ""), notifications };
}

// Close the server after each test so bun doesn't hang on the open handle.
let shutdown: (() => void) | undefined;
afterEach(() => {
	shutdown?.();
	shutdown = undefined;
});

async function get(url: string) {
	return fetch(url, { headers: { Connection: "close" } });
}

describe("wayfinder-map: /map command and server plumbing", () => {
	test("serves the vendored index.html at /", async () => {
		const { mounted, baseUrl } = await openMap();
		shutdown = () => mounted.handlers.session_shutdown?.({} as never, {} as never);

		const res = await get(`${baseUrl}/`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		const html = await res.text();
		expect(html).toContain("<canvas");
		// loading overlay is injected at serve time; the vendored file stays verbatim
		expect(html).toContain("wfm-loading");
	});

	test("/favicon.ico answers 204, not 404", async () => {
		const { mounted, baseUrl } = await openMap();
		shutdown = () => mounted.handlers.session_shutdown?.({} as never, {} as never);

		const res = await get(`${baseUrl}/favicon.ico`);
		expect(res.status).toBe(204);
	});

	test("/api/initial names the chosen map; /api/version is constant", async () => {
		const { mounted, baseUrl } = await openMap();
		shutdown = () => mounted.handlers.session_shutdown?.({} as never, {} as never);

		const initial = await (await get(`${baseUrl}/api/initial`)).json();
		expect(initial).toEqual({ effort: "1" });

		const version = await (await get(`${baseUrl}/api/version?effort=1`)).text();
		expect(version).toBe("0");
	});

	test("no wayfinder:map issue -> notify, no browser opened", async () => {
		const openedUrls: string[] = [];
		const notifications: string[] = [];
		const mounted = await mountExtension(wayfinderMap, { exec: makeGhExec(openedUrls, []) });
		await mounted.commands.map?.("", makeCommandContext(notifications));

		expect(openedUrls).toHaveLength(0);
		expect(notifications).toContainEqual(expect.stringContaining("No wayfinder:map issue"));
	});
});

describe("wayfinder-map: /api/graph derivation", () => {
	async function fetchGraph() {
		const { mounted, baseUrl } = await openMap();
		shutdown = () => mounted.handlers.session_shutdown?.({} as never, {} as never);
		const res = await get(`${baseUrl}/api/graph?effort=1`);
		expect(res.status).toBe(200);
		return res.json();
	}

	test("derives every status in the table", async () => {
		const g = await fetchGraph();
		const statusOf = Object.fromEntries(g.nodes.map((n: { num: number; status: string }) => [n.num, n.status]));
		expect(statusOf).toEqual({
			10: "resolved",
			11: "out_of_scope",
			12: "claimed",
			13: "frontier",
			14: "blocked",
			15: "blocked",
		});
	});

	test("counts fold frontier and blocked into open", async () => {
		const g = await fetchGraph();
		expect(g.counts).toEqual({ resolved: 1, claimed: 1, open: 3, outOfScope: 1, total: 6 });
	});

	test("edges carry satisfied = blocker closed", async () => {
		const g = await fetchGraph();
		expect(g.edges).toContainEqual({ from: 10, to: 13, satisfied: true });
		expect(g.edges).toContainEqual({ from: 12, to: 14, satisfied: false });
	});

	test("failed dependencies API falls back to the Blocked by: body line", async () => {
		const g = await fetchGraph();
		expect(g.edges).toContainEqual({ from: 13, to: 15, satisfied: false });
		const n15 = g.nodes.find((n: { num: number }) => n.num === 15);
		expect(n15.blockers).toEqual([13]);
	});

	test("rank is dependency depth", async () => {
		const g = await fetchGraph();
		const rankOf = Object.fromEntries(g.nodes.map((n: { num: number; rank: number }) => [n.num, n.rank]));
		expect(rankOf[10]).toBe(0);
		expect(rankOf[13]).toBe(1);
		expect(rankOf[15]).toBe(2);
	});

	test("claimed node carries claimedBy; type comes from the wayfinder:<type> label", async () => {
		const g = await fetchGraph();
		const n12 = g.nodes.find((n: { num: number }) => n.num === 12);
		expect(n12.claimedBy).toBe("golgor");
		expect(n12.type).toBe("grilling");
		const n15 = g.nodes.find((n: { num: number }) => n.num === 15);
		expect(n15.type).toBe("task");
	});

	test("destination and fog come from the map body", async () => {
		const g = await fetchGraph();
		expect(g.name).toBe("My Map");
		expect(g.destination).toBe("A spec for the timeline feature.");
		expect(g.fog).toEqual([
			{ title: "Today's row", clearsWith: 13 },
			{ title: "Error states", clearsWith: 0 },
		]);
	});
});
