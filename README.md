# pi-shell-timeout

A pi extension that gives a shell tool call a default `timeout` when the caller omits one.

```bash
pi install git:github.com/OldBoy405/pi-shell-timeout@v1.0.0
npm run selfcheck          # or: node extensions/pi-shell-timeout.ts --selfcheck
```

## Why this exists

pi arms no timer when a shell call omits `timeout`: `resolveTimeoutMs(undefined)` returns
`undefined` and the schema says `optional, no default timeout`. A hung command therefore holds the
tool call open with nothing able to end it. Measured, on one machine over two days:

| silence before the next `tool_result` | CPU burned before the process was killed |
|---|---|
| 1131s (18m51s) | ~1110s on one core |
| 1358s (22m38s) | ~1350s |
| 564s | 559.9s |

All three were whole-disk `find` calls. No `tool_result` ever arrived while they ran, so the model
had nothing to react to; every recovery was finding the exact child pid and killing it.

We first fixed this by patching pi's source. That works, but the patch has to be re-applied and
reinstalled on every upstream release. This extension does the same thing through pi's documented
extension API, so it lives outside pi: `pi update` and `pi update --extensions` cannot touch it and
there is no rebase to maintain.

## What it does

On `tool_call`, for a shell tool (`bash`, `powershell`, `shell`, `run_in_terminal`, `Bash`, `Shell`,
`PowerShell`), when the call carries no `timeout`, it sets `timeout` to **300** seconds. An explicit
value always wins, including an explicit value larger than the default.

## What it deliberately does not do

- **No escape hatch.** `# output-guard: full` is not honoured. The pi-side fix this mirrors has no
  bypass either, and a model-writable bypass on a *safety* default is a weakness, not a feature.
- **No shell parsing.** It never reads the command text, so `|`, `;`, quoting or another shell
  dialect cannot confuse it. It only ever fills in a missing field.
- **It does not cover the harness path** (`packages/agent/src/harness/**`, used by `pi-server`,
  `pi-chat` and sandboxes). Those runs do not go through this extension.

## Trade-off, stated plainly

A long-running command that does not pass `timeout` is now killed at 300 seconds. Builds, test
suites and migrations must pass an explicit `timeout` — the same trade-off the upstream default
would impose.

## Verifying it is working

```bash
node extensions/pi-shell-timeout.ts --selfcheck
```

Ten assertions, no dependencies: the default is injected, an explicit value is not overridden,
non-shell tools are untouched, malformed events are skipped rather than thrown on, and the entry
point registers the `tool_call` hook. It exits 0 on success and 1 on the first broken assertion.

### What "not working" looks like

pi's contract matters here:

- a `tool_call` handler that **throws blocks the tool** (fail-safe, loud);
- an extension that **fails to load is logged and the agent continues** (silent).

So the failure mode to watch for is the second one: the file stops loading and the bound quietly
disappears. That is why the self-check exists — run it after upgrading pi, and check the daemon log
for extension load errors (pi's stderr is captured there).

## Files

```
extensions/pi-shell-timeout.ts   the extension (zero dependencies, zero build step)
package.json                     pi package manifest (`pi.extensions`)
```

## Not mounting it twice

Pi deduplicates by identity: a git package is identified by its repository URL (without ref), while a
loose file is identified by its resolved absolute path. Those are **different identities**, so if this
extension is also sitting in `~/.pi/agent/extensions/`, both copies load and the handler runs twice.
That is harmless — the second run sees `timeout` already set and skips — but it is untidy. Pick one:
either install the package, or keep the loose file, not both.

## Upstream status

- `earendil-works/pi#9798` — contribution proposal for the same behaviour upstream (pending triage)
- `earendil-works/pi#9785` — the "no default or sane max" report, with our measurements
- `earendil-works/pi#9770` — find/grep tools have no timeout; bash's own timeout only applies when
  the caller passes it, which is what this extension closes

If upstream ever ships the default, this extension becomes redundant and can be removed with
`pi remove`.
