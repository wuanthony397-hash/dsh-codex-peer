# dsh-codex-peer

Peer collaboration between a DeepSeek Harness (DSH) agent and the local OpenAI **Codex CLI**.

Not an integration: Codex keeps its own session, tools, skills, sandbox, and model; DSH keeps its own.
The two agents exchange work the way two people on one repository do — one does a pass, the other
reviews it; one plans, the other executes — through ordinary tool calls and the files in the shared
working tree.

```
You: "have Codex implement the retry logic, then review what it wrote"
DSH: codex_plan(goal: "add retry logic")          →  the split is recorded as a shared work list
     codex_ask(mode: "implement", prompt: "...")   →  Codex edits the tree, reports back
     codex_review(target: "working-tree")          →  Codex is asked to attack its own diff
     (or the DSH agent writes its own review of the same diff)
```

> **Not affiliated with OpenAI or DeepSeek.** This plugin ships no code from either project: it
> drives the Codex CLI you installed yourself and uses the plugin API DeepSeek Harness publishes.
> "Codex" is a trademark of OpenAI and DeepSeek Harness is a DeepSeek project. You need your own
> Codex CLI installed and signed in; how you use it is your responsibility.

## What it adds

| Tool | What it does |
| --- | --- |
| `codex_ask` | Runs one Codex turn in the session's working directory and returns Codex's final message. `mode: ask \| plan \| implement` decides whether Codex answers, plans, or edits; `continueFromLast`/`resumeThreadId` continue an earlier Codex thread. |
| `codex_review` | Runs one **read-only** Codex turn whose answer must be a structured review (verdict + severity-ranked findings with file and line), produced with `codex exec --output-schema`. |
| `codex_status` | Reports where the Codex executable was found, its version on request, the effective settings, the shared work list (`tasks.summary` plus the open tasks), and the recent runs and resumable threads. |
| `codex_plan` | Agrees and records the split of a goal between this agent (`dsh`) and the Codex peer, as a shared work list both sides read. `goal` is required; `tasks` carries the split when it is already decided. Approving this call approves the plan. |
| `codex_task` | Works that list: `action: list \| show \| claim \| update \| record-evidence \| set-budget \| run`. `action: run` is a normal peer run attached to a task — refused when the task is out of Codex budget, charged against the task, continuing the task's Codex thread, and its outcome recorded as evidence. |

Every run is recorded: the assembled prompt, the raw `--json` event stream, stderr, the final
answer, and a metadata record under `$DSH_HOME/codex-peer/`. The shared work list lives in the same
directory: `tasks.json` plus its `tasks.ndjson` history.

## Requirements

- DSH `>= 0.2.0-rc.2` (`@deepseek-ai/dsh` peer, `@deepseek-ai/schemastery ^3.18.1`) and Node `>= 20`.
- The Codex CLI, installed and logged in.
- No runtime dependencies, and host-only: the Harness injects its own packages, this plugin declares
  none, and nothing is registered in a client bundle.

### Finding the Codex CLI

The desktop Codex app does not put itself on `PATH`, so discovery walks these candidates in order
and uses the first that exists:

1. `codexPath` from this plugin's configuration;
2. `CODEX_CLI_PATH` in the Codex `config.toml` (the desktop app writes it there);
3. `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe` (newest version directory first);
4. `%APPDATA%\npm\codex.cmd`;
5. `codex` / `codex.exe` / `codex.cmd` / `codex.bat` on `PATH`.

`codex_status` prints the winner, its source, and the candidates it rejected — if a call fails with
`codex CLI not found`, that output says exactly which paths were considered.

## Install

```bash
# through the DSH CLI (works while the desktop app is running)
dsh plugin --profile <profile> add /absolute/path/to/dsh-codex-peer

# or from the plugin market / package registry
dsh plugin --profile <profile> add dsh-codex-peer

# or straight from GitHub, pinned to a tag
dsh plugin --profile <profile> add github:wuanthony397-hash/dsh-codex-peer#v0.2.1
```

The plugin contributes a `dsh.bundle`, so DSH records it in `dsh.profile.bundles`. A restart
(or profile reload) is required before the tools appear: bundles compose at startup.

## Quick start

1. Install it (any way above) and **restart DSH** — the five tools appear only after a restart,
   because bundles compose at startup.
2. Check the setup by asking your agent *"check the codex peer status"*: it calls `codex_status` and
   prints where the Codex executable was found, the effective settings, and the work list.
3. Ask for the collaboration you want, in plain language — the agent calls the tools for you:

| What you say | What happens |
| --- | --- |
| "Split this between you two: Codex does the retry logic, you do the tests" | a user-directed split, recorded as a shared work list |
| "Work out between yourselves how to do X" | this agent drafts the split, Codex critiques it, then it is recorded |
| "Do it as a pipeline: plan, implement, review, fix" | four staged tasks, each with an owner |
| "Let Codex write a first version, then attack it" | one task produces, the other attacks |
| "Both of you attempt it independently, then compare" | two independent attempts plus a comparison task |
| "Just ask Codex what it thinks about X" | a single consulted answer, no work list |

4. Then work the list: *"show the work list"*, *"run the Codex side of task 2"*, *"task 2 is done,
   the evidence is the passing test run"*. Creating the plan asks for approval once; afterwards the
   tasks it covers no longer prompt. Each task carries a Codex budget (5 runs / 2M tokens by
   default) and cannot be marked done without evidence.

Every tool and every knob is documented in the sections below — none of it is required reading to
start, because the agent drives the tools.

## Configuration

Configuration lives in the profile's `cordis.patch.yml` — no path, model, or policy is hardcoded in
the tools. A patch row replaces the whole `config` block of that id, so state it completely:

```yaml
- insert:
    - id: codex-peer
      name: 'dsh-codex-peer'
      config:
        defaultMode: implement
        requireApproval: mutating
        model: ''                 # empty = Codex's own default from config.toml
        runTimeoutMs: 3600000
```

| Field | Default | Meaning |
| --- | --- | --- |
| `codexPath` | `''` | Explicit Codex executable. Highest-priority discovery candidate. |
| `codexHome` | `''` | `CODEX_HOME` for the child (Codex's own state root, including `auth.json`). Empty = inherit. |
| `stateDir` | `''` | Where runs and the ledger live. Empty = `$DSH_HOME/codex-peer`. |
| `model` | `''` | `codex exec -m` override. Empty = Codex's configured default. |
| `defaultMode` | `ask` | Mode for `codex_ask` calls that omit `mode`. |
| `defaultSandbox` | `''` | Sandbox for calls that omit `sandbox`; empty derives it from the mode (implement → `workspace-write`, otherwise `read-only`). |
| `requireApproval` | `mutating` | `mutating`: ask before a run that may write. `always`: ask before every peer call. `never`: no gate. A `codex_plan` call is always asked for once unless `never`. |
| `callTimeoutMs` | `600000` | How long a foreground call waits before it is promoted to a background job. |
| `runTimeoutMs` | `1800000` | Hard ceiling for one Codex run; the process tree is terminated when it is hit. |
| `maxAnswerBytes` | `120000` | Answer budget returned to the model; the full message stays in `answer.md`. |
| `progressKeepLines` | `400` | Progress lines kept in memory for `job_output` and failure notes. |
| `terminateGraceMs` | `5000` | Termination grace (managed seam SIGTERM→SIGKILL window; tree-kill window for a direct launch). |
| `extraArgs` | `[]` | Extra arguments appended to every `codex exec` invocation. |
| `promptPreamble` | `''` | Replaces the built-in peer-contract preamble that is prepended to every prompt. |
| `planFile` | `''` | Optional repository-relative path for a markdown mirror of the work list, for example `.codex-peer/PLAN.md`. Empty writes no file, because `tasks.json` in the state directory stays the single source of truth. |
| `routingRules` | the shipped routing table | Array of `{when, owner, reason}`; `when` is a lower-case word or phrase matched against a task's title, tags and scope, first match wins. |
| `defaultOwner` | `dsh` | Owner when no routing rule matches. |
| `maxCodexRunsPerTask` | `5` | How many Codex runs one task may spend before a task-scoped run is refused. Raise it per task with `codex_task action:set-budget`. |
| `maxCodexTokensPerTask` | `2000000` | How many Codex tokens one task may spend before a task-scoped run is refused; `0` disables the token ceiling. |
| `approvePerTask` | `true` | With `true`, approving a plan covers that task's mutating Codex runs, so they are not asked one by one. `false` restores per-run asking. |

## Planning a split

`codex_plan` records who does what as a work list both agents read. `goal` is required; `tasks`
carries the split when it is already decided (each entry takes a required `title` plus `owner`,
`acceptance`, `scope`, `tags`, and `why`), and `budget`, `replace`, `mirror`, and `cwd` shape the
rest. `mode` is a recipe over the same work list:

| Mode | How the split is decided |
| --- | --- |
| `assigned` (default) | The user named who does what. |
| `self-organizing` | The routing table decided by strength; this agent drafts the split and Codex critiques it before it is recorded (default `propose: dsh`). |
| `pipeline` | Cut into stages: Plan (codex), Implement (codex), Review (codex), Fix and verify (dsh). |
| `adversarial` | One side produces, the other attacks it (`producer` picks who writes first; dsh is the default, so Codex attacks). |
| `blind` | Both sides solve it independently, then dsh compares and picks. |
| `consult` | No split: a single question, answered by one side. |

`propose` ∈ `dsh` (default: this agent drafts, Codex critiques), `codex` (Codex drafts first), or
`none` (record the split as-is without calling Codex).

The routing table is plain data (`routingRules`): each `{when, owner, reason}` matches a lower-case
word or phrase against a task's title, tags and scope, first match wins. The shipped rules send
bulk/rename/migrate/review/audit/second-opinion/survey/summarize/draft to `codex`, and
debug/interactive/plugin/install/verify/integration/decision to `dsh`, each with a one-line reason.
`defaultOwner` (default `dsh`) takes whatever no rule matches.

## The shared work list

The list is stored in the state directory as `tasks.json` (current state) plus `tasks.ndjson`
(append-only history of every change, so "who assigned what, when" stays answerable). Both agents
read it; `codex_task` moves it:

| `action` | What it does |
| --- | --- |
| `list` / `show` | Read the whole list or one task. |
| `claim` | Take a task, naming the owner. |
| `update` | Change `status`, `owner`, `acceptance`, `scope`, `tags`, or `blockedBy`. |
| `record-evidence` | Attach the proof behind a task, optionally setting its status. |
| `set-budget` | Raise or lower the task's Codex budget. |
| `run` | Run the task's Codex side (see below). |

Task statuses are exactly `todo`, `doing`, `blocked`, `done`, `unverified`. A task cannot be marked
`done` without at least one evidence entry; marking it `unverified` requires a note saying what is
missing. Evidence kinds are `command`, `artifact`, `review`, and `note`.

`action: run` is a normal peer run attached to a task: refused when the task is out of Codex
budget, charged against the task, continuing the task's Codex thread, and its outcome recorded as
evidence.

Set `planFile` to write a markdown mirror of the work list at a repository-relative path such as
`.codex-peer/PLAN.md`. Empty writes no file, because `tasks.json` in the state directory stays the
single source of truth.

## Budgets

Every task carries `budget: {maxRuns, maxTokens}` and `spent: {runs, tokens}`. A task-scoped run —
`codex_task action:run`, or any run attached to a task — is refused once the budget is reached, with
a message naming the limit and pointing at `codex_task action:set-budget`. The defaults are
`maxCodexRunsPerTask: 5` and `maxCodexTokensPerTask: 2000000` (`0` disables the token ceiling).

## Approval and sandboxing

Starting Codex starts a second agent with write access to the same tree — and that child is **not**
wrapped by the Harness sandbox. The `-s/--sandbox` mode handed to `codex exec` is the only bound on
what it writes, which is why the plugin asks first:

- `codex_plan` is always asked for once (unless `requireApproval: never`), because approving it is
  what lets Codex write inside those tasks. With `approvePerTask: true` (default) an approved task's
  mutating Codex runs no longer ask one by one; `approvePerTask: false` restores per-run asking.
- `requireApproval: mutating` (default) asks before any run that may write: `mode: implement`,
  `sandbox: workspace-write`, or `sandbox: danger-full-access` — except a run covered by an approved
  task under `approvePerTask`.
- `codex_review` is pinned to `read-only` and never asks under `mutating`.
- The ask goes through the Harness approval service, and it is fail-closed: with no approver
  available the call is denied rather than run.

Codex itself needs to write its own home directory (`~/.codex`: state, logs, `auth.json`). If a call
fails with `failed to initialize in-process app-server client: 拒绝访问 (os error 5)` or
`could not create PATH aliases`, Codex's home is not writable in the current confinement — widen the
sandbox for that command, or point `codexHome` at a writable directory (a copy of `auth.json` is
then required, and note Codex rotates refresh tokens).

## Background runs

With the Harness job service loaded (the base bundle provides it), every run becomes a job owned by
the calling agent:

- `background: true` returns immediately with a job handle;
- a foreground call that outlives `callTimeoutMs` is **promoted** instead of killed, and the tool
  result names the job;
- `job_output` streams the progress lines the plugin feeds the job (thread start, each command and
  its exit code, file changes, token usage), and `job_kill` cancels the run, terminating the Codex
  process tree.

Without the job service the tools still work; `background: true` is refused with an explanation
instead of silently behaving differently.

## State on disk

```
$DSH_HOME/codex-peer/
├── runs.ndjson              # one JSON record per run: status, mode, sandbox, usage, thread, label
├── threads.json             # working directory → last Codex thread id (what continueFromLast reads)
├── tasks.json               # the shared work list: current state
├── tasks.ndjson             # append-only history of every work-list change
└── runs/<runId>/
    ├── prompt.md            # the exact text handed to Codex on stdin
    ├── events.jsonl         # the raw `codex exec --json` event stream
    ├── stderr.txt           # Codex diagnostics (token-refresh warnings, transport fallbacks, …)
    ├── answer.md            # the final message as Codex wrote it (-o)
    ├── meta.json            # outcome record: status, exit code, usage, commands, file changes, notes
    └── output-schema.json   # present only for schema-constrained runs such as codex_review
```

Nothing is pruned automatically: delete old `runs/<runId>` directories when you care about size. A
configured `planFile` mirror is written into the repository, not into this directory.

## How a peer run is assembled

1. The prompt is a collaboration contract, not just your words: it states the shared working tree,
   that no human will answer a question (so Codex must assume and proceed), that changes stay in
   scope, and that the final message must stand alone with what changed, the evidence, and open
   questions. `promptPreamble` replaces that contract.
2. The prompt travels on **stdin** (`codex exec … -`), never on the command line — Windows caps a
   command line at ~32k characters and a hand-off prompt exceeds that.
3. `codex exec resume` accepts neither `-s/--sandbox` nor `-C/--cd`, so resumed runs pin the sandbox
   with `-c sandbox_mode="…"` and inherit the working directory from the spawned process.
4. Process supervision prefers the Harness subprocess seam (`ctx.subprocess`): environment scrubbing,
   a whole-process-range SIGTERM→grace→SIGKILL ladder, and no orphaned `codex.exe` when the service
   is disposed. Without that seam the plugin falls back to `node:child_process` and kills the tree
   with `taskkill /T` on Windows or the process group elsewhere; the fallback is noted in the run
   record.
5. The event stream is folded incrementally: thread id, per-item progress (commands, file changes,
   todos, MCP and web-search items), final answer, token usage, and every error.

## Tool result shape

Each tool returns one JSON object (rendered to text for the model):

```jsonc
// codex_ask, finished
{ "status": "completed", "runId": "codex-20261008-101010-abcd", "mode": "implement",
  "sandbox": "workspace-write", "launcher": "subprocess", "threadId": "01a1…",
  "usage": { "inputTokens": 22406, "cachedInputTokens": 13184, "outputTokens": 7, "totalTokens": 22413 },
  "answer": "…", "commands": [{ "command": "npm test", "exitCode": 0 }],
  "fileChanges": ["update lib/a.js"], "notes": [], "artifacts": { "events": "…", "answer": "…" } }

// codex_ask, still running (promoted or background)
{ "status": "running", "kind": "promoted", "jobId": "…", "progressTail": "…", "artifacts": { … } }

// codex_review
{ "status": "completed", "structured": true,
  "review": { "verdict": "concerns", "summary": "…",
              "findings": [{ "severity": "major", "title": "…", "file": "lib/a.js", "line": 12,
                             "detail": "…", "suggestion": "…" }] },
  "run": { "runId": "…", "answerPath": "…", "usage": { … }, "notes": [] } }
```

`codex_review` asks Codex for a strict schema (`verdict` ∈ `pass|concerns|fail`, `findings[]` with
`severity` ∈ `blocker|major|minor|nit`). If Codex answers outside that shape, the tool returns the
raw text with `structured: false` rather than pretending it parsed.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `codex CLI not found` — with a candidate list | Codex is not where discovery looks. Set `codexPath` in the config; `codex_status` shows what was considered. |
| `os error 5` / `拒绝访问` at startup | Codex cannot write its home. Widen the sandbox for that command or set `codexHome` to a writable directory (needs `auth.json`). |
| `Failed to refresh token: 403 … unsupported_country_region_territory` on stderr | Codex's token refresh is blocked for the current region. Runs continue until the token expires, then Codex must be logged in again. |
| A call returns `status: "running"` | The run outlived `callTimeoutMs` and is now a job: read it with `job_output`, stop it with `job_kill`. |
| `status: "timeout"` | The run passed `runTimeoutMs` and its process tree was terminated. Raise the ceiling or narrow the request. |
| `background Codex runs need the job service` | The profile has no job service. Load `@deepseek-ai/dsh-tool-jobs` (the base bundle does) or drop `background: true`. |

## Development

```
index.js            plugin entry: config, ledger, tools, approval gate, optional seams
lib/config.js       the schemastery Config contract and mode → sandbox derivation
lib/locate.js       Codex discovery and version probe
lib/argv.js         prompt assembly (peer contract + mode) and the codex argument vector
lib/events.js       JSONL event folding, progress log with offset reads, usage normalization
lib/review.js       the review JSON schema, prompt, and lenient normalization of the answer
lib/runner.js       plan a run, execute it, stream it, and record the outcome
lib/execute.js      foreground/background selection through the job service
lib/launch.js       managed subprocess seam with a direct-spawn fallback
lib/ledger.js       run index, thread memory, atomic artifact writes
lib/gate.js         tools/pre-execute approval policy
lib/tools.js        `codex_ask`, `codex_review`, `codex_status` and their text renderers
lib/tasks.js        the shared work list: ids, statuses, evidence, budgets, history
lib/plan.js         the six modes, the routing table, and the plan JSON schema
lib/planning-tools.js  `codex_plan` and `codex_task`
test/unit.test.js   49 offline tests
```

```bash
npm test          # node test/unit.test.js — all tests offline, no Codex process
node --test test/ # the same tests through the test runner (needs child processes)
```

The tests never start Codex: `executeRun` gets an injected `spawnImpl` that replays a captured
`codex exec --json` stream, and discovery is answered with a file the test creates.

## License

MIT
