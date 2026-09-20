/**
 * pi-shell-timeout — give an omitted shell `timeout` a default, without patching pi.
 *
 * WHY THIS EXISTS
 * ---------------
 * Upstream arms no timer when a shell tool call omits `timeout`
 * (`resolveTimeoutMs(undefined) → undefined`, schema text "optional, no default timeout"), so a
 * hung command holds the tool call open with nothing able to end it. We measured three of those:
 * whole-disk `find` calls that sat for 564s / 1131s / 1358s with no `tool_result` at all, each
 * recovered by hand-killing the child pid.
 *
 * We first fixed it by patching pi's source. That works, but it has to be re-applied and reinstalled
 * on every upstream release. This extension does the same thing through pi's documented extension
 * API instead: it lives outside pi, so `pi update` / `pi update --extensions` cannot touch it and no
 * rebase is ever needed.
 *
 * WHAT IT DOES
 * ------------
 * On `tool_call` for a shell tool, when the call carries no `timeout`, set it to
 * DEFAULT_SHELL_TIMEOUT_SECONDS. An explicit value always wins, including an explicit large one.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * - No escape-hatch carve-out (`# output-guard: full`). The pi-side fix this mirrors has no bypass
 *   either, and a model-writable bypass on a *safety* default is a weakness, not a feature. If you
 *   want the marker honoured, that is a deliberate change to make here, not an oversight.
 * - No shell parsing. It never inspects the command text, so it cannot be fooled by `|`, `;`, quotes
 *   or another shell dialect; it only ever fills in a missing field.
 * - It does not fix the harness path (`packages/agent/src/harness/**`, used by pi-server / pi-chat /
 *   sandboxes). Those runs do not go through this extension.
 *
 * FAILURE BEHAVIOUR
 * -----------------
 * pi's contract: a `tool_call` handler that throws BLOCKS the tool, while an extension that fails to
 * load is logged and the agent continues. So a broken extension would remove the bound silently.
 * This handler therefore never throws on its own account and writes one stderr line instead, matching
 * the convention our output-guard adapter already uses (`OUTPUT_GUARD_UNAVAILABLE`). Silence is the
 * one outcome to avoid: check that it is mounted and working with
 *
 *     node pi-shell-timeout.ts --selfcheck
 *
 * It also announces itself: the first injection in a process writes one stderr line
 * (`PI_SHELL_TIMEOUT_INJECTED seconds=300 tool=bash`). Without it, a loaded extension that works
 * and a missing one look identical from the outside until a command actually hangs. One line per
 * process, so a run with many shell calls stays quiet; the daemon captures pi's stderr, so it lands
 * in the daemon log under a `pi:stderr` tag.
 *
 * MOUNTING
 * --------
 * Drop this file in pi's extension discovery directory (`~/.pi/agent/extensions/`) or point
 * `~/.pi/agent/settings.json#extensions` at it. Discovery-directory installs need no settings edit.
 */

/** Tool names that execute a shell command. Mirrors the shell-tool list our output-guard uses. */
const SHELL_TOOLS = new Set([
	"bash",
	"Bash",
	"Shell",
	"shell",
	"run_in_terminal",
	"powershell",
	"PowerShell",
]);

/**
 * Keep this equal to pi-agent-core's `DEFAULT_SHELL_TIMEOUT_SECONDS`. It is duplicated on purpose:
 * this file must stay dependency-free and mountable on a stock pi install, so it cannot import the
 * constant from the patched package. `--selfcheck` reports the value so a drift is visible.
 */
const DEFAULT_SHELL_TIMEOUT_SECONDS = 300;

/* ── decision ─────────────────────────────────────────────────────────────────────────────────── */

/**
 * Applies the default in place, the way pi's extension API expects input changes to happen
 * (later `tool_call` handlers observe mutations made by earlier ones).
 *
 * Returns a short outcome string so the self-check can assert on behaviour rather than on state.
 */
export function applyShellTimeout(event) {
	const toolName = typeof event?.toolName === "string" ? event.toolName : "";
	if (!SHELL_TOOLS.has(toolName)) return "skipped:not-a-shell-tool";

	const input = event?.input;
	if (input === null || typeof input !== "object" || Array.isArray(input)) return "skipped:no-input";
	if (input.timeout !== undefined) return "skipped:explicit-timeout";

	input.timeout = DEFAULT_SHELL_TIMEOUT_SECONDS;
	return "injected";
}

export default function piShellTimeout(pi) {
	// Announce the FIRST injection per process. The mechanism is otherwise invisible: an extension
	// that stopped loading looks exactly like one that never fires, and both look like the timeout
	// simply never being needed. One line per process keeps a run with many shell calls quiet.
	let announced = false;
	pi.on("tool_call", async (event) => {
		try {
			if (applyShellTimeout(event) !== "injected") return;
			if (announced) return;
			announced = true;
			const tool = typeof event?.toolName === "string" ? event.toolName : "?";
			process.stderr.write(
				`PI_SHELL_TIMEOUT_INJECTED seconds=${DEFAULT_SHELL_TIMEOUT_SECONDS} tool=${tool}\n`,
			);
		} catch (err) {
			process.stderr.write(
				`PI_SHELL_TIMEOUT_UNAVAILABLE reason=${err && err.name ? err.name : "unknown"}\n`,
			);
		}
	});
}

/* ── self-check: `node pi-shell-timeout.ts --selfcheck` ───────────────────────────────────────── */

if (process.argv[1] && process.argv[1].endsWith("pi-shell-timeout.ts")) {
	const checks = [];
	const check = (name, got, want) => checks.push({ name, ok: got === want, got, want });

	// The case that motivated all of this: a shell call with no timeout gets the default.
	const bare = { toolName: "bash", input: { command: "find / -name x" } };
	check("bare bash call is injected", applyShellTimeout(bare), "injected");
	check("  and the injected value is the default", bare.input.timeout, DEFAULT_SHELL_TIMEOUT_SECONDS);

	// An explicit value must never be overridden, including one longer than the default.
	const explicit = { toolName: "bash", input: { command: "sleep 1", timeout: 1200 } };
	check("explicit timeout wins", applyShellTimeout(explicit), "skipped:explicit-timeout");
	check("  and keeps its value", explicit.input.timeout, 1200);

	// Non-shell tools are not touched at all.
	const other = { toolName: "read", input: { path: "a" } };
	check("non-shell tool untouched", applyShellTimeout(other), "skipped:not-a-shell-tool");
	check("  and gains no timeout field", "timeout" in other.input, false);

	// The powershell tool shares the same execution path and is covered too.
	const ps = { toolName: "powershell", input: { command: "ls" } };
	check("powershell call is injected", applyShellTimeout(ps), "injected");

	// Malformed events must be skipped, never thrown on.
	check("missing input is skipped", applyShellTimeout({ toolName: "bash" }), "skipped:no-input");
	check("array input is skipped", applyShellTimeout({ toolName: "bash", input: [] }), "skipped:no-input");

	// The extension entry point must register exactly the hook we rely on.
	const registered = [];
	piShellTimeout({ on: (name) => registered.push(name) });
	check("registers the tool_call hook", registered.join(","), "tool_call");

	// Drive the entry point itself so the announcement is covered rather than assumed: one line, on
	// the first injection only, naming the value and the tool. Capture stderr for the duration.
	{
		let handler;
		piShellTimeout({ on: (_name, h) => { handler = h; } });
		const captured = [];
		const realWrite = process.stderr.write;
		process.stderr.write = (chunk) => { captured.push(String(chunk)); return true; };
		try {
			await handler({ toolName: "bash", input: { command: "a" } });
			await handler({ toolName: "bash", input: { command: "b" } });
			await handler({ toolName: "bash", input: { command: "c", timeout: 5 } });
			await handler({ toolName: "read", input: { path: "x" } });
		} finally {
			process.stderr.write = realWrite;
		}
		check("announces the first injection only", captured.length, 1);
		check("  and the line names the default", (captured[0] || "").includes("seconds=300"), true);
		check("  and the tool that was bounded", (captured[0] || "").includes("tool=bash"), true);
	}

	const failed = checks.filter((c) => !c.ok);
	for (const c of checks) {
		console.log(`  ${c.ok ? "ok  " : "FAIL"}  ${c.name}${c.ok ? "" : ` (got ${JSON.stringify(c.got)}, want ${JSON.stringify(c.want)})`}`);
	}
	console.log("");
	console.log(
		failed.length === 0
			? `PI_SHELL_TIMEOUT OK (default ${DEFAULT_SHELL_TIMEOUT_SECONDS}s, ${checks.length} checks)`
			: `PI_SHELL_TIMEOUT BROKEN (${failed.length}/${checks.length} checks failed)`,
	);
	process.exit(failed.length === 0 ? 0 : 1);
}
