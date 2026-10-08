/**
 * The human-readable copy of the collaboration, written into the working tree.
 *
 * The state directory (`$DSH_HOME/codex-peer`) is the record the plugin reads:
 * run indexes, thread memory, the work list. That is not somewhere a person
 * browses while working, so when `workspaceDir` is set (default `.codex-peer`)
 * every run is also mirrored next to the code:
 *
 * ```
 * <cwd>/.codex-peer/
 *   README.md                      what this folder is, and that deleting it is safe
 *   LATEST.md                      the newest transcript — open this one first
 *   worklist.md                    readable mirror of the shared work list
 *   runs/<runId>/
 *     transcript.md                request, everything Codex did, the final answer
 *     prompt.md events.jsonl stderr.txt answer.md meta.json
 * ```
 *
 * Mirroring is best-effort by design: a failure to write a convenience copy is
 * recorded as a note on the run and never turns a successful run into a failed
 * one.
 *
 * @module dsh-codex-peer/workspace
 */
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { renderPlanMarkdown } from './plan.js'

/** How many commands and file changes a transcript lists before summarising. */
const MAX_COMMANDS = 40
const MAX_FILES = 60
const MAX_SNIPPETS = 6000

/**
 * A `.gitignore` inside the mirror that ignores the mirror.
 *
 * This folder holds the assembled prompt, the whole event stream and the answer —
 * everything that passed through the collaboration. An accidental `git add .` in
 * a public repository is the one way this readable copy can actually hurt, so the
 * folder ignores itself: git reports nothing inside it, and committing a file on
 * purpose still works with `git add -f`.
 */
const SELF_IGNORE = [
  '# Written by dsh-codex-peer. These are transcripts of agent runs, so they stay',
  '# out of git by default. Commit one anyway with `git add -f <file>`.',
  '*',
  '',
].join('\n')

/** @returns the absolute workspace mirror root, or undefined when disabled. */
export function workspaceRoot(config, cwd) {
  const configured = String(config?.workspaceDir ?? '').trim()
  if (configured === '') return undefined
  const base = String(cwd ?? process.cwd())
  // Only mirror into a working directory that really exists: inventing a tree
  // for a path that is not there would litter whatever directory we ran from.
  try {
    if (!existsSync(base) || !statSync(base).isDirectory()) return undefined
  } catch {
    return undefined
  }
  return resolve(base, configured)
}

/** @returns the paths inside one workspace mirror root. */
export function workspacePaths(root, runId) {
  return {
    root,
    readme: join(root, 'README.md'),
    worklist: join(root, 'worklist.md'),
    latest: join(root, 'LATEST.md'),
    runsDir: join(root, 'runs'),
    runDir: join(root, 'runs', runId),
    transcript: join(root, 'runs', runId, 'transcript.md'),
  }
}

/** @returns the one-off note that explains the folder. */
export function renderWorkspaceReadme() {
  return [
    '# .codex-peer — what this folder is',
    '',
    'Written by the `dsh-codex-peer` plugin while it works with the local Codex CLI.',
    '',
    '| File | What it holds |',
    '| --- | --- |',
    '| `LATEST.md` | the transcript of the newest run — read this one first |',
    '| `worklist.md` | who is doing what, with status, scope, acceptance, evidence |',
    '| `runs/<runId>/transcript.md` | one run: the assembled request, every command with its exit code, the files changed, the final answer |',
    '| `runs/<runId>/` | the raw artifacts the transcript is built from: `prompt.md`, `events.jsonl`, `stderr.txt`, `answer.md`, `meta.json` |',
    '',
    'The plugin keeps its own source of truth in `$DSH_HOME/codex-peer` (run index, thread memory,',
    'the work list). This folder is a readable copy for you: delete it at any time. It also ignores',
    'itself — the `.gitignore` in here is `*` — so git reports nothing from it. To commit a transcript',
    'on purpose, name the file: `git add -f .codex-peer/LATEST.md`. Change where the folder goes — or',
    'turn it off — with the `workspaceDir` setting (empty string disables it).',
    '',
  ].join('\n')
}

/** @returns markdown for the full transcript of one run. */
export function renderTranscript(plan, outcome) {
  const usage = outcome.usage
  const lines = [
    `# codex ${outcome.runId}`,
    '',
    `- status: **${outcome.status}** · mode: ${outcome.mode} · sandbox: ${outcome.sandbox}${outcome.model === '' ? '' : ` · model: ${outcome.model}`}`,
    `- working directory: ${outcome.cwd}`,
    `- launcher: ${outcome.launcher}${outcome.resumedThreadId === null ? '' : ` · resumed thread ${outcome.resumedThreadId}`}${typeof outcome.threadId === 'string' && outcome.threadId !== '' ? ` · thread ${outcome.threadId}` : ''}`,
    `- duration: ${(outcome.durationMs / 1000).toFixed(1)}s · started ${outcome.startedAt} · ended ${outcome.endedAt}`,
  ]
  if (usage !== null && usage !== undefined) {
    lines.push(`- tokens: in ${usage.inputTokens ?? 0} · cached ${usage.cachedInputTokens ?? 0} · out ${usage.outputTokens ?? 0} · total ${usage.totalTokens ?? 0}`)
  }
  if (outcome.exitCode !== null) lines.push(`- exit code: ${outcome.exitCode}${outcome.signal === null ? '' : ` · signal ${outcome.signal}`}`)

  lines.push('', '## Request', '', '```text', clip(plan.prompt, MAX_SNIPPETS), '```')

  lines.push('', '## What Codex did', '')
  if (outcome.commands.length === 0) lines.push('(no command was reported)')
  else {
    for (const command of outcome.commands.slice(0, MAX_COMMANDS)) {
      lines.push(`- \`${command.command}\` → exit ${command.exitCode === null ? '?' : command.exitCode}`)
    }
    if (outcome.commands.length > MAX_COMMANDS) lines.push(`- … ${outcome.commands.length - MAX_COMMANDS} more command(s), all of them in \`events.jsonl\``)
  }
  if (outcome.fileChanges.length > 0) {
    lines.push('', '### Files changed', '')
    for (const file of outcome.fileChanges.slice(0, MAX_FILES)) lines.push(`- ${file}`)
    if (outcome.fileChanges.length > MAX_FILES) lines.push(`- … ${outcome.fileChanges.length - MAX_FILES} more, in \`events.jsonl\``)
  }

  lines.push('', '## Final answer', '', outcome.answer === '' ? '(the run produced no final message)' : outcome.answer)
  if (outcome.truncated === true) lines.push('', `> The answer above was clipped by \`maxAnswerBytes\`; the full text is in \`answer.md\`.`)

  const notes = [...(outcome.errors ?? []).map((error) => `error: ${error}`), ...(outcome.notes ?? [])]
  if (notes.length > 0) {
    lines.push('', '## Errors and notes', '')
    for (const note of notes) lines.push(`- ${note}`)
  }
  return `${lines.join('\n')}\n`
}

/** @returns markdown for the work list mirror. */
export function renderWorklist(tasks, at) {
  const first = tasks[0]
  return renderPlanMarkdown(
    {
      goal: first?.goal ?? first?.title ?? '(no goal recorded)',
      mode: first?.mode ?? 'assigned',
    },
    tasks,
    at,
  )
}

/** Truncate long text for a transcript, keeping the head and tail. */
function clip(text, max) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  const half = Math.floor(max / 2)
  return `${value.slice(0, half)}\n\n[… clipped for the transcript; the full text is in prompt.md …]\n\n${value.slice(-half)}`
}

/** Keep the mirror out of git, best-effort like the rest of it. */
function writeSelfIgnore(root) {
  try {
    writeFileSync(join(root, '.gitignore'), SELF_IGNORE, 'utf8')
  } catch {
    // a mirror that cannot be written is reported by the caller, not thrown here
  }
}

/** Copy one artifact when it exists, returning its name when it did. */
function mirrorArtifact(from, to) {
  try {
    if (!existsSync(from) || statSync(from).size === 0) return undefined
    copyFileSync(from, to)
    return to
  } catch {
    return undefined
  }
}

/**
 * Write the workspace copy of one finished run.
 *
 * @param options - `{ root, runId, plan, outcome, tasks?, now? }`.
 * @returns `{ root, runDir, transcript, latest, worklist }` with the paths written.
 */
export function mirrorRun(options) {
  const root = options.root
  const paths = workspacePaths(root, options.runId)
  mkdirSync(paths.runDir, { recursive: true })
  writeSelfIgnore(root)

  for (const name of ['prompt.md', 'events.jsonl', 'stderr.txt', 'answer.md', 'meta.json', 'output-schema.json']) {
    mirrorArtifact(join(options.plan.paths.runDir, name), join(paths.runDir, name))
  }

  const transcript = renderTranscript(options.plan, options.outcome)
  writeFileSync(paths.transcript, transcript, 'utf8')
  writeFileSync(paths.latest, transcript, 'utf8')
  writeFileSync(paths.readme, renderWorkspaceReadme(), 'utf8')

  let worklist
  if (Array.isArray(options.tasks) && options.tasks.length > 0) {
    writeFileSync(paths.worklist, renderWorklist(options.tasks, options.now ?? options.outcome.endedAt), 'utf8')
    worklist = paths.worklist
  }

  return { root, runDir: paths.runDir, transcript: paths.transcript, latest: paths.latest, worklist }
}

/**
 * Refresh just the work list mirror, after a plan or task change.
 *
 * @param options - `{ cwd, config, tasks, at }`.
 * @returns the path written, or undefined when the mirror is off or empty.
 */
export function mirrorWorklist(options) {
  const root = workspaceRoot(options.config, options.cwd)
  if (root === undefined) return undefined
  if (!Array.isArray(options.tasks) || options.tasks.length === 0) return undefined
  mkdirSync(root, { recursive: true })
  writeSelfIgnore(root)
  const paths = workspacePaths(root, 'unused')
  writeFileSync(paths.readme, renderWorkspaceReadme(), 'utf8')
  writeFileSync(paths.worklist, renderWorklist(options.tasks, options.at ?? new Date().toISOString()), 'utf8')
  return paths.worklist
}
