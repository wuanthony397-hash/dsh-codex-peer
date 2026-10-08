# Changelog

All notable changes to `dsh-codex-peer` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-10-08

### Added

- **The collaboration is readable from the working directory.** With `workspaceDir` (default
  `.codex-peer`) every run is mirrored next to the code: `LATEST.md` (the newest transcript),
  `worklist.md` (the shared work list), and `runs/<runId>/transcript.md` — the assembled request,
  every command with its exit code, the files changed, the final answer, tokens and duration — with
  the raw `prompt.md`, `events.jsonl`, `stderr.txt`, `answer.md`, and `meta.json` beside it. Set
  `workspaceDir` to an empty string to turn the copy off; the state directory keeps the record either
  way. A mirror that cannot be written is reported as a note on the run, never as a failure.
- `codex_status` reports the workspace directory it writes to.

### Changed

- `worklist.md` is refreshed after every `codex_plan` and `codex_task` call, so the readable plan
  follows the work list without waiting for a run.

## [0.2.3] — 2026-10-08

### Fixed

- The install instructions no longer suggest `dsh plugin add dsh-codex-peer` "from the plugin market
  or package registry": the package is not on npm and is not listed in the market, so that command
  would fail. Both READMEs now say so plainly and give the four routes that work — a tag-pinned
  GitHub install, the default branch, a downloaded release tarball, or a local clone — and warn that
  the tarball path is recorded in the profile, so the file has to stay put.

## [0.2.2] — 2026-10-08

### Added

- A **Quick start** section in both READMEs (English and 简体中文): install, restart, confirm the
  setup with `codex_status`, and what to say to get each of the six collaboration modes — plus the
  daily actions (show the work list, run a task's Codex side, record evidence).
- A plain affiliation note: the plugin is not affiliated with OpenAI or DeepSeek and ships no code
  from either project.

### Changed

- Nothing in the code. This release exists so the published package carries the documentation the
  repository shows.

## [0.2.1] — 2026-10-08

### Fixed

- Every tool now answers with lossless JSON. The harness rejects a result holding
  `undefined`, `NaN`, `Infinity`, a function, or a `Date`, and `codex_status` failed its first live
  call for exactly that reason (`codex.version` and `codex.probeError` are empty when no version
  probe ran). A single `withLosslessResult` wrapper now sanitises every registered tool's result:
  empty object fields are dropped, empty array elements and non-finite numbers become `null`, dates
  become ISO strings, and true cycles are cut.

## [0.2.0] — 2026-10-08

The peer now plans before it runs: a goal is split between the two agents, recorded as a shared work
list, and worked task by task under a per-task budget.

### Added

- `codex_plan` — agree and record the split of a goal between `dsh` and the Codex peer as a shared
  work list both sides read, from the tasks the user named or from a mode that works the split out.
- `codex_task` — work that list: `list`, `show`, `claim`, `update`, `record-evidence`, `set-budget`,
  and `run`, where `run` is a normal peer run attached to a task (budgeted, charged to the task,
  continuing the task's Codex thread, and recorded as evidence).
- Six plan modes over the same work list — `assigned` (default), `self-organizing`, `pipeline`,
  `adversarial`, `blind`, and `consult` — with `propose` choosing whether this agent drafts, Codex
  drafts first, or no Codex call is made.
- The shared work list on disk: `tasks.json` for current state and `tasks.ndjson` as the append-only
  history of every change, with statuses `todo`, `doing`, `blocked`, `done`, and `unverified`.
- A configurable routing table (`routingRules`) matching words in a task's title, tags, and scope —
  first match wins — plus `defaultOwner` for whatever no rule matches.
- Per-task Codex budgets (`maxCodexRunsPerTask` default 5, `maxCodexTokensPerTask` default 2000000;
  `0` disables the token ceiling): a task-scoped run is refused once the budget is reached, with a
  message naming the limit and pointing at `codex_task action:set-budget`.
- Per-task approval: `codex_plan` is always asked for once (unless `requireApproval: never`) and is
  the approval point for the tasks it creates; with `approvePerTask` (default `true`) an approved
  task's mutating Codex runs no longer ask one by one, and `false` restores per-run asking.
- An evidence gate: a task cannot be marked `done` without at least one evidence entry, and marking
  it `unverified` requires a note saying what is missing. Evidence kinds are `command`, `artifact`,
  `review`, and `note`.
- An optional `planFile` markdown mirror of the work list, written at a repository-relative path.
- `codex_status` now also reports the work list: `tasks.summary` plus the open tasks.

### Changed

- Test count 38 → 49, all still offline through `npm test` (`node test/unit.test.js`).

## [0.1.0] — 2026-10-08

First release. The plugin runs the local Codex CLI as a peer agent: it hands Codex a piece of work,
brings the result back with its evidence, and records everything on disk.

### Added

- `codex_ask` — one Codex turn in the session working directory, in `ask`, `plan`, or `implement`
  mode, with `continueFromLast` / `resumeThreadId` to continue an earlier Codex thread.
- `codex_review` — a read-only Codex review whose answer is constrained by
  `codex exec --output-schema` to a verdict plus severity-ranked findings with file and line, with a
  lenient parser and an explicit `structured: false` fallback.
- `codex_status` — Codex discovery result and candidates, optional version probe, effective
  settings, recent runs, and resumable threads.
- Peer collaboration contract in every prompt: shared working tree, no interactive human, scope
  discipline, evidence over claims, and a self-contained hand-off as the final message.
- Approval gate on `tools/pre-execute`: `requireApproval` of `mutating` (default), `always`, or
  `never`, fail-closed through the Harness approval service.
- Process supervision that prefers the Harness subprocess seam (`ctx.subprocess`, with environment
  scrubbing and whole-process-range termination) and falls back to `node:child_process` with
  `taskkill /T` on Windows or a process-group kill elsewhere.
- Background runs through the job service: `background: true`, automatic promotion of a foreground
  call that outlives `callTimeoutMs`, streaming progress via `job_output`, cancellation via
  `job_kill`.
- Incremental `codex exec --json` event folding: thread id, commands and exit codes, file changes,
  todos, MCP and web-search items, errors, and token usage.
- Artifact ledger under `$DSH_HOME/codex-peer`: `runs.ndjson`, `threads.json`, and per-run
  `prompt.md`, `events.jsonl`, `stderr.txt`, `answer.md`, `meta.json`, `output-schema.json`.
- Configuration through the profile's `cordis.patch.yml` only — no path, model, timeout, or policy
  is hardcoded in the tools.
- 38 offline unit tests, including a replayed `codex exec --json` stream through an injected spawn.
