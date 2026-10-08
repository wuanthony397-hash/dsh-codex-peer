/**
 * The tools the peer exposes.
 *
 * `codex_ask` runs a peer turn, `codex_review` runs the same turn with a
 * machine-readable answer contract, `codex_status` explains the setup, and the
 * work-list tools (`codex_plan`, `codex_task`) live in
 * {@link module:dsh-codex-peer/planning-tools}. Everything a caller can vary is
 * a parameter there or a config field — nothing is baked in.
 *
 * Tool definitions are plain objects (the shape shipped tools use) rather than
 * `defineTool` output, because this plugin declares no runtime dependencies and
 * the parameter schema is written as raw JSON Schema.
 *
 * @module dsh-codex-peer/tools
 */
import { MODES, SANDBOXES } from './config.js'
import { runPeerRequest } from './execute.js'
import { withLosslessResult } from './json.js'
import { codexHomeDir, locateCodex, probeCodexVersion } from './locate.js'
import { codexPlanTool, codexTaskTool } from './planning-tools.js'
import { REVIEW_SCHEMA, buildReviewPrompt, countFindings, normalizeReview, parseLooseJson } from './review.js'
import { mirrorWorklist, workspaceRoot } from './workspace.js'

/** How many progress lines a still-running result carries inline. */
const PROGRESS_TAIL_LINES = 12

/** @returns the last `count` lines of a progress log, as one block. */
function progressTail(progress, count = PROGRESS_TAIL_LINES) {
  const lines = progress.text().trimEnd().split('\n').filter((line) => line !== '')
  if (lines.length === 0) return ''
  return lines.slice(Math.max(0, lines.length - count)).join('\n')
}

/** @returns the shared header line of an ask/review outcome. */
function headerLine(outcome) {
  const bits = [`codex ${outcome.mode}`, outcome.status]
  if (outcome.resumedThreadId !== null) bits.push(`resumed ${outcome.resumedThreadId}`)
  if (typeof outcome.threadId === 'string' && outcome.threadId !== '') bits.push(`thread ${outcome.threadId}`)
  if (outcome.usage !== null) bits.push(`${outcome.usage.totalTokens} tokens`)
  bits.push(`${(outcome.durationMs / 1000).toFixed(1)}s`)
  bits.push(outcome.runId)
  return bits.join(' · ')
}

/** @returns the lines that describe what Codex ran and changed. */
function evidenceLines(outcome) {
  const lines = []
  for (const command of outcome.commands.slice(0, 12)) {
    lines.push(`$ ${command.command} → exit ${command.exitCode === null ? '?' : command.exitCode}`)
  }
  if (outcome.commands.length > 12) lines.push(`… ${outcome.commands.length - 12} more command(s) in ${outcome.eventsPath}`)
  if (outcome.fileChanges.length > 0) lines.push(`files: ${outcome.fileChanges.slice(0, 20).join(', ')}`)
  return lines
}

/** @returns the lines that describe problems and caveats. */
function noteLines(outcome) {
  const lines = []
  for (const error of outcome.errors.slice(0, 6)) lines.push(`error: ${error}`)
  for (const note of outcome.notes) lines.push(`note: ${note}`)
  return lines
}

/** @returns the status block a promoted or background run renders. */
function runningText(value) {
  const lines = [
    `[codex ${value.mode} is still running; background job ${value.jobId}]`,
    `run ${value.runId} · ${value.runDir}`,
  ]
  const tail = value.progressTail ?? ''
  if (tail !== '') lines.push('', 'recent progress:', tail)
  lines.push(
    '',
    `Read more with job_output (job_id ${value.jobId}); stop it with job_kill. The full answer is written to ${value.artifacts.answer} when the run finishes.`,
  )
  return lines.join('\n')
}

/** @returns the rendered text of a codex_ask result. */
export function renderAskResult(value) {
  if (value.status === 'running') return runningText(value)
  const lines = [headerLine(value), `run ${value.runId} · ${value.runDir}`, '', value.answer === '' ? '(no final message)' : value.answer]
  const evidence = evidenceLines(value)
  if (evidence.length > 0) lines.push('', ...evidence)
  const notes = noteLines(value)
  if (notes.length > 0) lines.push('', ...notes)
  return lines.join('\n')
}

/** @returns the rendered text of a codex_review result. */
export function renderReviewResult(value) {
  if (value.status === 'running') return runningText(value)
  const review = value.review
  const counts = countFindings(review.findings)
  const lines = [
    `codex review · ${review.verdict} · ${counts.total} finding(s) (${counts.blocker} blocker, ${counts.major} major, ${counts.minor} minor, ${counts.nit} nit)`,
    headerLine({ ...value.run, mode: 'review', status: value.run.status }),
    '',
    review.summary,
  ]
  for (const finding of review.findings) {
    const where = finding.file === null ? '' : ` (${finding.file}${finding.line === null ? '' : `:${finding.line}`})`
    lines.push('', `- [${finding.severity}] ${finding.title}${where}`, `  ${finding.detail}`)
    if (finding.suggestion !== null) lines.push(`  suggestion: ${finding.suggestion}`)
  }
  if (value.structured !== true) lines.push('', `(the answer was not the structured review object; raw text above is in ${value.run.answerPath})`)
  const notes = noteLines(value.run)
  if (notes.length > 0) lines.push('', ...notes)
  return lines.join('\n')
}

/** @returns the rendered text of a codex_status result. */
export function renderStatusResult(value) {
  const lines = [
    `codex-peer state: ${value.stateDir}`,
    `codex CLI: ${value.codex.available ? `${value.codex.path ?? '(unknown)'}${value.codex.version === undefined ? '' : ` · ${value.codex.version}`}` : 'not found'}`,
  ]
  if (value.codex.available !== true) {
    for (const candidate of value.codex.considered) lines.push(`  considered: ${candidate}`)
  }
  if (value.codex.probeError !== undefined && value.codex.probeError !== null) lines.push(`  version probe failed: ${value.codex.probeError}`)
  if (typeof value.workspaceDir === 'string' && value.workspaceDir !== '') lines.push(`workspace copy: ${value.workspaceDir}`)
  lines.push(
    '',
    `settings: mode=${value.config.defaultMode} sandbox=${value.config.defaultSandbox} model=${value.config.model === '' ? '(codex default)' : value.config.model} approval=${value.config.requireApproval} callTimeout=${value.config.callTimeoutMs}ms runTimeout=${value.config.runTimeoutMs}ms`,
  )
  if (value.runs.length === 0) lines.push('', 'no Codex peer runs recorded yet')
  else {
    lines.push('', `recent runs (${value.runs.length}):`)
    for (const run of value.runs) {
      const tokens = run.usage === null ? '' : ` ${run.usage.totalTokens} tokens`
      lines.push(
        `- ${run.startedAt} · ${run.status} · ${run.mode}/${run.sandbox} · ${(run.durationMs / 1000).toFixed(1)}s${tokens} · ${run.runId}`,
      )
      lines.push(`  cwd ${run.cwd}`)
    }
  }
  if (value.threads.length > 0) {
    lines.push('', 'resumable threads (working directory → thread):')
    for (const thread of value.threads) lines.push(`- ${thread.cwd} → ${thread.threadId}`)
  }
  return lines.join('\n')
}

/** The parameter schema shared by the three tools' common knobs. */
function commonProperties() {
  return {
    cwd: {
      type: 'string',
      description: 'Working directory Codex runs in. Defaults to the session working directory.',
    },
    model: { type: 'string', description: 'Model override passed to `codex exec -m`. Defaults to the plugin config.' },
    background: {
      type: 'boolean',
      description: 'Return a background job handle immediately instead of waiting for the run to finish.',
    },
  }
}

/** @returns the JSON value of a finished-or-running ask outcome. */
function askValue(result) {
  const { plan, progress } = result
  if (result.kind !== 'run') {
    return {
      status: 'running',
      kind: result.kind,
      jobId: result.jobId,
      mode: plan.mode,
      sandbox: plan.sandbox,
      runId: plan.runId,
      runDir: plan.paths.runDir,
      cwd: plan.cwd,
      progressTail: progressTail(progress),
      artifacts: {
        prompt: plan.paths.promptPath,
        events: plan.paths.eventsPath,
        stderr: plan.paths.stderrPath,
        answer: plan.paths.answerPath,
        meta: plan.paths.metaPath,
      },
    }
  }
  const outcome = result.outcome
  return {
    status: outcome.status,
    kind: 'run',
    runId: outcome.runId,
    runDir: outcome.runDir,
    mode: outcome.mode,
    sandbox: outcome.sandbox,
    model: outcome.model,
    launcher: outcome.launcher,
    cwd: outcome.cwd,
    threadId: outcome.threadId,
    resumedThreadId: outcome.resumedThreadId,
    usage: outcome.usage,
    durationMs: outcome.durationMs,
    exitCode: outcome.exitCode,
    answer: outcome.answer,
    truncated: outcome.truncated,
    commands: outcome.commands,
    fileChanges: outcome.fileChanges,
    errors: outcome.errors,
    notes: outcome.notes,
    artifacts: {
      prompt: plan.paths.promptPath,
      events: plan.paths.eventsPath,
      stderr: plan.paths.stderrPath,
      answer: plan.paths.answerPath,
      meta: plan.paths.metaPath,
    },
  }
}

/**
 * `codex_ask` — one peer turn in the Codex CLI.
 * @param peer - the runtime peer object.
 * @returns the tool definition.
 */
export function codexAskTool(peer) {
  return {
    name: 'codex_ask',
    description:
      'Run one turn of the local Codex CLI as a peer agent in this working tree and get its final message back. Codex keeps its own session, tools, and skills, sees the same files, and its sandbox mode bounds what it may write. Use it for a second implementation pass you then review, an independent plan you then execute, or a question you want answered by another agent. mode=ask answers without editing, mode=plan returns a plan without editing, mode=implement edits the working tree. A run that outlives the foreground timeout returns a background job handle; read it with job_output. Prompt, event stream, and answer are recorded under the codex-peer state directory.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        prompt: {
          type: 'string',
          description:
            'The request for Codex, written as a self-contained hand-off. It cannot ask you questions mid-run, so state the goal, the constraints, and what the final message must contain.',
        },
        mode: { type: 'string', enum: MODES, description: 'ask (default): answer only. plan: plan only. implement: edit the working tree.' },
        sandbox: {
          type: 'string',
          enum: SANDBOXES,
          description:
            'Codex sandbox override: read-only, workspace-write, or danger-full-access. Defaults to the mode-derived sandbox (implement writes, ask/plan read).',
        },
        continueFromLast: {
          type: 'boolean',
          description: 'Continue the last Codex thread used in this working directory (`codex exec resume --last`), keeping its context.',
        },
        resumeThreadId: { type: 'string', description: 'Continue one specific Codex thread by id or name.' },
        label: { type: 'string', description: 'Short label for the run in the ledger and the background job list.' },
        ...commonProperties(),
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: renderAskResult(value) }] },
    presentCall(args) {
      return { card: 'generic', title: `codex_ask · ${String(args.mode ?? 'ask')}`, kind: 'other', rawInput: args }
    },
    async execute(args, exec) {
      const result = await runPeerRequest(
        peer,
        {
          prompt: args.prompt,
          mode: args.mode,
          sandbox: args.sandbox,
          model: args.model,
          cwd: args.cwd,
          background: args.background,
          continueFromLast: args.continueFromLast,
          resumeThreadId: args.resumeThreadId,
          label: args.label,
        },
        exec,
      )
      return askValue(result)
    },
  }
}

/**
 * `codex_review` — the same turn with a structured answer contract.
 * @param peer - the runtime peer object.
 * @returns the tool definition.
 */
export function codexReviewTool(peer) {
  return {
    name: 'codex_review',
    description:
      'Have the local Codex CLI review a diff as an independent reviewer and return structured findings: a verdict plus severity-ranked items with file, line, evidence, and a suggested fix. This is the review half of the peer workflow (codex implements, you review; or codex reviews what you wrote). Read-only: Codex is pinned to the read-only sandbox and told not to modify files. The structured answer is produced by `codex exec --output-schema`, so the result is JSON in the shape this tool declares; if Codex answers outside that shape the raw text is returned with structured=false.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: {
          type: 'string',
          description:
            'What to review: "working-tree" (default, uncommitted changes including untracked files), "staged", "last-commit", or a literal instruction such as a commit range or a path.',
        },
        focus: { type: 'string', description: 'What the reviewer should weight most, for example the concurrency or error-handling angle.' },
        label: { type: 'string', description: 'Short label for the run in the ledger and the background job list.' },
        ...commonProperties(),
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: renderReviewResult(value) }] },
    presentCall(args) {
      return { card: 'generic', title: `codex_review · ${String(args.target ?? 'working-tree')}`, kind: 'other', rawInput: args }
    },
    async execute(args, exec) {
      const cwd = String(args.cwd ?? exec?.agent?.session?.header?.cwd ?? process.cwd())
      const target = args.target ?? 'working-tree'
      const result = await runPeerRequest(
        peer,
        {
          prompt: buildReviewPrompt({ target, focus: args.focus, cwd }),
          mode: 'ask',
          sandbox: 'read-only',
          model: args.model,
          cwd,
          background: args.background,
          label: args.label ?? `review · ${target}`,
          outputSchemaText: JSON.stringify(REVIEW_SCHEMA, null, 2),
        },
        exec,
      )
      if (result.kind !== 'run') {
        const running = askValue(result)
        return { ...running, review: null }
      }
      const outcome = result.outcome
      const parsed = parseLooseJson(outcome.answer)
      const normalized = normalizeReview(parsed, outcome.answer)
      return {
        status: outcome.status,
        kind: 'run',
        structured: normalized.structured,
        review: { verdict: normalized.verdict, summary: normalized.summary, findings: normalized.findings },
        reviewNotes: normalized.notes,
        run: {
          runId: outcome.runId,
          runDir: outcome.runDir,
          status: outcome.status,
          answerPath: outcome.answerPath,
          eventsPath: outcome.eventsPath,
          threadId: outcome.threadId,
          usage: outcome.usage,
          durationMs: outcome.durationMs,
          model: outcome.model,
          launcher: outcome.launcher,
          commands: outcome.commands,
          fileChanges: outcome.fileChanges,
          errors: outcome.errors,
          notes: outcome.notes,
        },
      }
    },
  }
}

/**
 * `codex_status` — what the peer setup looks like right now.
 * @param peer - the runtime peer object.
 * @returns the tool definition.
 */
export function codexStatusTool(peer) {
  return {
    name: 'codex_status',
    description:
      'Report the Codex peer setup: which Codex CLI executable was found (and where it was discovered), its version on request, the state directory holding run artifacts, the effective settings, and the recent peer runs with their status, mode, sandbox, token use, and working directory. Use it before blaming a failure on Codex, and to find the thread id of an earlier run to continue with codex_ask continueFromLast.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', description: 'How many recent runs to list (1-100, default 10).' },
        probe: { type: 'boolean', description: 'Also run `codex --version` to confirm the executable actually starts.' },
        cwd: { type: 'string', description: 'Working directory to report the remembered thread for. Defaults to the session working directory.' },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: renderStatusResult(value) }] },
    presentCall(args) {
      return { card: 'generic', title: 'codex_status', kind: 'other', rawInput: args }
    },
    async execute(args, exec) {
      const config = peer.config
      const limit = Math.min(100, Math.max(1, Math.trunc(typeof args.limit === 'number' ? args.limit : 10)))
      const located = locateCodex(config)
      const probe = args.probe === true && located.available ? await probeCodexVersion(located.path) : undefined
      const cwd = String(args.cwd ?? exec?.agent?.session?.header?.cwd ?? process.cwd())
      return {
        status: 'ok',
        stateDir: peer.ledger.dir,
        stateDirExists: peer.ledger.exists(),
        workspaceDir: workspaceRoot(config, cwd) ?? null,
        codex: {
          available: located.available,
          path: located.path,
          source: located.source,
          version: probe?.version ?? null,
          probeError: probe !== undefined && probe.ok !== true ? (probe.error ?? null) : null,
          considered: located.candidates.slice(0, 8).map((candidate) => `${candidate.path} (${candidate.source})`),
          codexHome: codexHomeDir(config),
        },
        config: {
          defaultMode: config.defaultMode,
          defaultSandbox: config.defaultSandbox === '' ? '(derived from mode)' : config.defaultSandbox,
          model: config.model,
          requireApproval: config.requireApproval,
          callTimeoutMs: config.callTimeoutMs,
          runTimeoutMs: config.runTimeoutMs,
          terminateGraceMs: config.terminateGraceMs,
          maxAnswerBytes: config.maxAnswerBytes,
          extraArgs: config.extraArgs,
        },
        session: { cwd, lastThread: peer.ledger.lastThread(cwd) ?? null },
        tasks:
          peer.tasks === undefined
            ? { summary: { total: 0 }, open: [], note: 'the work list is unavailable in this composition' }
            : {
                summary: peer.tasks.summary(),
                open: peer.tasks
                  .list()
                  .filter((task) => task.status !== 'done')
                  .map((task) => ({ id: task.id, title: task.title, owner: task.owner, status: task.status })),
              },
        runs: peer.ledger.listRuns(limit),
        threads: peer.ledger.listThreads(),
      }
    },
  }
}

/**
 * Refresh the readable work list in the working tree after a call that can change
 * it. Best-effort, like the rest of the workspace copy: the mirror is a
 * convenience, never a reason to fail a call.
 * @param peer - the runtime peer object.
 * @param tool - the tool to wrap.
 * @returns the wrapped tool.
 */
function withWorklistMirror(peer, tool) {
  return {
    ...tool,
    async execute(args, exec) {
      const value = await tool.execute(args, exec)
      try {
        const cwd = String(args?.cwd ?? exec?.agent?.session?.header?.cwd ?? process.cwd())
        mirrorWorklist({ cwd, config: peer.config, tasks: peer.tasks?.list?.() ?? [], at: new Date().toISOString() })
      } catch {
        // A missing mirror must never turn a successful call into a failure.
      }
      return value
    },
  }
}

/**
 * Register every tool, effect-scoped.
 * @param ctx - the plugin context.
 * @param peer - the runtime peer object.
 * @returns a disposer that unregisters every tool.
 */
export function registerTools(ctx, peer) {
  // Every tool's result goes through withLosslessResult: one `undefined` field
  // is enough for the harness to reject the whole call as non-lossless JSON.
  // The two work-list tools also keep the readable copy in the working tree current.
  const disposers = [
    ctx.tools.register(withLosslessResult(codexAskTool(peer))),
    ctx.tools.register(withLosslessResult(codexReviewTool(peer))),
    ctx.tools.register(withLosslessResult(codexStatusTool(peer))),
    ctx.tools.register(withLosslessResult(withWorklistMirror(peer, codexPlanTool(peer)))),
    ctx.tools.register(withLosslessResult(withWorklistMirror(peer, codexTaskTool(peer)))),
  ].filter((disposer) => typeof disposer === 'function')
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // Already disposed with the fiber.
      }
    }
  }
}
