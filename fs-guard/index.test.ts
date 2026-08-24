/**
 * Behavioral tests for fs-guard. These double as documentation of the
 * extension's contract — see CONTEXT.md for the reasoning behind each rule.
 */

import { describe, expect, test } from "bun:test";
import { makeBashToolCallEvent, makeContext, mountExtension } from "../test-utils/harness";
import fsGuard from "./index";

const HOME = process.env.HOME ?? "";

async function callToolCall(command: string, options: Parameters<typeof makeContext>[0]) {
	const { handlers } = await mountExtension(fsGuard);
	return handlers.tool_call?.(makeBashToolCallEvent(command), makeContext(options));
}

describe("fs-guard: always-blocked patterns (no confirmation offered)", () => {
	test("blocks dd writing to a raw disk device", async () => {
		const result = await callToolCall("dd if=/dev/zero of=/dev/sda bs=1M count=1", { cwd: "/tmp" });
		expect(result).toMatchObject({ block: true });
		expect((result as { reason: string }).reason).toContain("always-blocked");
	});

	test("blocks a fork bomb", async () => {
		const result = await callToolCall(":(){ :|:& };:", { cwd: "/tmp" });
		expect(result).toMatchObject({ block: true });
	});

	test("blocks mkfs", async () => {
		const result = await callToolCall("mkfs.ext4 /dev/sdb1", { cwd: "/tmp" });
		expect(result).toMatchObject({ block: true });
	});

	test("blocks wipefs", async () => {
		const result = await callToolCall("wipefs -a /dev/sdb", { cwd: "/tmp" });
		expect(result).toMatchObject({ block: true });
	});

	test("blocks recursive chmod on /", async () => {
		const result = await callToolCall("chmod -R 000 /", { cwd: "/tmp" });
		expect(result).toMatchObject({ block: true });
	});

	test("always-block wins even when the target would otherwise be inside an allowed root", async () => {
		const result = await callToolCall("dd if=/dev/zero of=/dev/sda", { cwd: "/tmp/fs-guard-test" });
		expect(result).toMatchObject({ block: true });
	});
});

describe("fs-guard: allowed roots run with zero friction", () => {
	test("rm -rf inside the launch cwd is allowed, no confirmation prompt", async () => {
		let confirmCalled = false;
		const { handlers } = await mountExtension(fsGuard);
		const ctx = makeContext({ cwd: "/tmp/fs-guard-test" });
		ctx.ui.confirm = async () => {
			confirmCalled = true;
			return true;
		};
		const result = await handlers.tool_call?.(makeBashToolCallEvent("rm -rf ./scratch"), ctx);
		expect(result).toBeUndefined(); // undefined = allow, no block
		expect(confirmCalled).toBe(false);
	});

	test("deletions under ~/Code/Work are allowed regardless of cwd", async () => {
		const result = await callToolCall(`rm -rf ${HOME}/Code/Work/some-project/build`, { cwd: "/tmp" });
		expect(result).toBeUndefined();
	});

	test("deletions under ~/Code/Personal are allowed regardless of cwd", async () => {
		const result = await callToolCall(`rm -rf ${HOME}/Code/Personal/some-project/dist`, { cwd: "/tmp" });
		expect(result).toBeUndefined();
	});

	test("deletions under /tmp are allowed regardless of cwd", async () => {
		const result = await callToolCall("rm -rf /tmp/some-scratch-dir", { cwd: `${HOME}/Code/Work/proj` });
		expect(result).toBeUndefined();
	});

	test("/tmp stays trusted even when cwd is $HOME", async () => {
		const result = await callToolCall("rm -rf /tmp/some-scratch-dir", { cwd: HOME, hasUI: false });
		expect(result).toBeUndefined();
	});

	test("deleting a protected root itself is gated", async () => {
		const result = await callToolCall("rm -rf /tmp", { cwd: "/tmp/fs-guard-test", hasUI: false });
		expect(result).toMatchObject({ block: true });
		expect((result as { reason: string }).reason).toContain("itself");
	});

	test("deleting the launch cwd itself is gated", async () => {
		const result = await callToolCall("rm -rf .", { cwd: "/tmp/fs-guard-test", hasUI: false });
		expect(result).toMatchObject({ block: true });
	});

	test("find -delete on a protected root itself is gated", async () => {
		const result = await callToolCall("find /tmp -name '*.log' -delete", { cwd: "/tmp/fs-guard-test", hasUI: false });
		expect(result).toMatchObject({ block: true });
	});

	test("non-destructive commands are always left untouched", async () => {
		const result = await callToolCall("ls -la /etc", { cwd: "/tmp" });
		expect(result).toBeUndefined();
	});
});

describe("fs-guard: cwd is only trusted when it isn't too broad", () => {
	test("a destructive command is gated when cwd is exactly $HOME", async () => {
		const result = await callToolCall("rm -rf ./test-file.md", { cwd: HOME, hasUI: false });
		expect(result).toMatchObject({ block: true });
	});

	test("a destructive command is gated when cwd is the filesystem root", async () => {
		const result = await callToolCall("rm -rf ./whatever", { cwd: "/", hasUI: false });
		expect(result).toMatchObject({ block: true });
	});

	test("a non-$HOME, non-root cwd is still fully trusted", async () => {
		const result = await callToolCall("rm -rf ./scratch", { cwd: "/tmp/fs-guard-test" });
		expect(result).toBeUndefined();
	});

	test("~/Code/Work and ~/Code/Personal stay trusted even when cwd is $HOME", async () => {
		const result = await callToolCall(`rm -rf ${HOME}/Code/Work/some-project/build`, { cwd: HOME, hasUI: false });
		expect(result).toBeUndefined();
	});
});

describe("fs-guard: destructive commands outside allowed roots are gated", () => {
	test("blocked outright when no UI is available to confirm", async () => {
		const result = await callToolCall("rm -rf /var/tmp/outside", { cwd: "/tmp/fs-guard-test", hasUI: false });
		expect(result).toMatchObject({ block: true });
		expect((result as { reason: string }).reason).toContain("no UI available");
	});

	test("runs if the user approves the confirmation prompt", async () => {
		const result = await callToolCall("rm -rf /var/tmp/outside", { cwd: "/tmp/fs-guard-test", hasUI: true, confirm: true });
		expect(result).toBeUndefined();
	});

	test("blocked if the user declines the confirmation prompt", async () => {
		const result = await callToolCall("rm -rf /var/tmp/outside", { cwd: "/tmp/fs-guard-test", hasUI: true, confirm: false });
		expect(result).toMatchObject({ block: true });
		expect((result as { reason: string }).reason).toContain("declined");
	});
});

describe("fs-guard: fails closed on unresolvable targets", () => {
	test("a shell variable target is treated as ambiguous", async () => {
		const result = await callToolCall('TARGET=/tmp/x; rm -rf "$TARGET"', { cwd: "/tmp/fs-guard-test", hasUI: false });
		expect(result).toMatchObject({ block: true });
		expect((result as { reason: string }).reason).toContain("could not be confidently resolved");
	});

	test("command substitution is treated as ambiguous", async () => {
		const result = await callToolCall("rm -rf $(cat targets.txt)", { cwd: "/tmp/fs-guard-test", hasUI: false });
		expect(result).toMatchObject({ block: true });
	});

	test("a glob target is treated as ambiguous", async () => {
		const result = await callToolCall("rm -rf /tmp/fs-guard-test/*.log", { cwd: "/tmp/fs-guard-test", hasUI: false });
		expect(result).toMatchObject({ block: true });
	});

	test("a preceding `cd` makes a later relative deletion ambiguous", async () => {
		const result = await callToolCall("cd /var/tmp && rm -rf ./scratch", { cwd: "/tmp/fs-guard-test", hasUI: false });
		expect(result).toMatchObject({ block: true });
	});

	test("an absolute path after a preceding `cd` is still resolved normally (not ambiguous)", async () => {
		const result = await callToolCall("cd /var/tmp && rm -rf /tmp/fs-guard-test/scratch", { cwd: "/tmp/fs-guard-test", hasUI: false });
		expect(result).toBeUndefined();
	});
});

describe("fs-guard: alternate deletion vectors", () => {
	test("catches deletion piped through xargs", async () => {
		const result = await callToolCall("find . -name '*.tmp' | xargs rm -f", { cwd: "/tmp/fs-guard-test", hasUI: false });
		expect(result).toMatchObject({ block: true });
		expect((result as { reason: string }).reason).toContain("xargs");
	});

	test("catches find -delete targeting outside the allowed roots", async () => {
		const result = await callToolCall("find /var/tmp -name '*.log' -delete", { cwd: "/tmp/fs-guard-test", hasUI: false });
		expect(result).toMatchObject({ block: true });
		expect((result as { reason: string }).reason).toContain("find");
	});

	test("find -delete inside an allowed root runs with zero friction", async () => {
		const result = await callToolCall("find /tmp/fs-guard-test -name '*.log' -delete", { cwd: "/tmp/fs-guard-test" });
		expect(result).toBeUndefined();
	});

	test("catches git clean -fdx targeting outside the allowed roots", async () => {
		const result = await callToolCall("git clean -fdx /var/tmp/some-repo", { cwd: "/tmp/fs-guard-test", hasUI: false });
		expect(result).toMatchObject({ block: true });
	});

	test("git clean -fdx with no path defaults to (allowed) cwd", async () => {
		const result = await callToolCall("git clean -fdx", { cwd: "/tmp/fs-guard-test" });
		expect(result).toBeUndefined();
	});
});

describe("fs-guard: system prompt guidance", () => {
	test("appends a safety note to the system prompt", async () => {
		const { handlers } = await mountExtension(fsGuard);
		const result = await handlers.before_agent_start?.(
			{
				type: "before_agent_start",
				prompt: "hello",
				systemPrompt: "BASE PROMPT",
				systemPromptOptions: {} as never,
			},
			makeContext({ cwd: "/tmp" }),
		);
		expect((result as { systemPrompt: string }).systemPrompt).toContain("BASE PROMPT");
		expect((result as { systemPrompt: string }).systemPrompt).toContain("fs-guard");
	});
});
