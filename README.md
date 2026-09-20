# pi-extensions

Two pi extensions that steer pi's behaviour, kept **outside pi's source** so `pi update` and
`pi update --extensions` cannot silently drop them.

| Extension | What it does | Self-check |
|---|---|---|
| [`pi-shell-timeout`](#pi-shell-timeout) | gives a shell call that omits `timeout` a 300s default | `node extensions/pi-shell-timeout.ts --selfcheck` |
| [`ponytail-always`](#ponytail-always) | injects the ponytail skill, but only on turns that look like coding work | `node extensions/ponytail-always.ts --selfcheck` |

```bash
pi install git:github.com/OldBoy405/pi-extensions@v1.1.0
npm run selfcheck:all
```

## Layout

```
extensions/pi-shell-timeout.ts   shell-call default timeout (zero dependencies)
extensions/ponytail-always.ts    conditional ponytail injection (zero dependencies)
package.json                     pi package manifest (`pi.extensions`)
```

Both are dependency-free and need no build step: only `node:` builtins, plus a type-only import of
`@earendil-works/pi-coding-agent` that is erased at run time. Both run their own self-check under
plain `node` — no `tsx`, no install step.

---

## pi-shell-timeout

### Why this exists

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
extension API, so `pi update` cannot touch it and there is no rebase to maintain.

### What it does

On `tool_call`, for a shell tool (`bash`, `powershell`, `shell`, `run_in_terminal`, `Bash`, `Shell`,
`PowerShell`), when the call carries no `timeout`, it sets `timeout` to **300** seconds. An explicit
value always wins, including an explicit value larger than the default.

### What it deliberately does not do

- **No escape hatch.** `# output-guard: full` is not honoured. The pi-side fix this mirrors has no
  bypass either, and a model-writable bypass on a *safety* default is a weakness, not a feature.
- **No shell parsing.** It never reads the command text, so `|`, `;`, quoting or another shell
  dialect cannot confuse it. It only ever fills in a missing field.
- **It does not cover the harness path** (`packages/agent/src/harness/**`, used by `pi-server`,
  `pi-chat` and sandboxes). Those runs do not go through this extension.

### Trade-off, stated plainly

A long-running command that does not pass `timeout` is now killed at 300 seconds. Builds, test
suites and migrations must pass an explicit `timeout` — the same trade-off the upstream default
would impose.

### Verifying it

```bash
node extensions/pi-shell-timeout.ts --selfcheck
```

Twelve assertions, no dependencies: the default is injected, an explicit value is not overridden,
non-shell tools are untouched, malformed events are skipped rather than thrown on, the entry point
registers the `tool_call` hook, and the extension writes nothing to stdout or stderr. Exits 0 on
success, 1 on the first broken assertion.

### Upstream status

- `earendil-works/pi#9798` — contribution proposal for the same behaviour upstream (pending triage)
- `earendil-works/pi#9785` — the "no default or sane max" report, with our measurements
- `earendil-works/pi#9770` — find/grep tools have no timeout; bash's own timeout only applies when
  the caller passes it, which is what this extension closes

If upstream ever ships the default, this extension becomes redundant and can be removed with
`pi remove`.

---

## ponytail-always

Injects the ponytail skill into the system prompt **only on turns that look like coding work**,
decided by a local keyword heuristic — no extra model call.

### Why conditional

Injecting the skill on every turn costs roughly 2K tokens per turn. Most turns here are not coding
work (documents, questions, chat), so an unconditional injection is mostly waste. The heuristic is
an order of precedence, applied to the current prompt:

1. an explicit trigger word (`ponytail`, `be lazy`, `yagni`, …) → **inject**
2. the prompt is a document-writing task (PRD / SDD / design or requirements docs) → **skip**,
   deliberately not covered — this also blocks the "wrote code, then writes the doc" history path
3. the prompt looks strongly non-coding (translation, recipe, poem, résumé, …) and carries no
   coding signal → **skip**
4. the prompt carries a coding signal → **inject**
5. no signal at all (`continue`, `ok`) → look back at the last few user messages on the current
   branch; a coding signal there → **inject**
6. nothing → **skip**

### Mechanism and cost

`before_agent_start` fires once per turn and returns a modified `systemPrompt`. The system prompt is
rebuilt per turn and held constant within it, so one injection covers the turn. Measured cost is
about 2K tokens per injected turn.

### Known limit

The heuristic cannot tell "a question about programming" from "a coding task" — `Python 的 GIL 是什么`
is a documented false positive in its own test cases. The upgrade path, if it ever matters, is one
lightweight classification call. Removing the file and reloading restores the previous behaviour.

### Where the skill text comes from

It **reads** `~/.pi/agent/skills/ponytail/SKILL.md` at run time and skips silently when the file is
missing. It does not bundle or redistribute the skill; the [ponytail
skill](https://github.com/DietrichGebert/ponytail) stays where it was installed.

### Verifying it

```bash
node extensions/ponytail-always.ts --selfcheck
```

Seventeen cases over the precedence order, including the known false positive, which is asserted
explicitly rather than hidden.

---

## Not mounting these twice

pi deduplicates by identity: a **git package** is identified by its repository URL (without ref),
while a **loose file** is identified by its resolved absolute path. Those are different identities,
so a copy in `~/.pi/agent/extensions/` and a copy in this package both load. What that costs depends
on the extension:

- `pi-shell-timeout` — harmless. It is idempotent: the second run sees `timeout` already set and
  does nothing.
- `ponytail-always` — **not harmless.** Its handler appends the skill text to whatever
  `systemPrompt` it is handed, so two loaded copies inject twice and every coding turn pays roughly
  double the tokens.

So for this package, keep exactly one copy: either install it, or keep loose files, never both.
