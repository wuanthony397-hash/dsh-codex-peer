/**
 * Running one Codex peer turn.
 *
 * A run is planned first ({@link planRun}) and executed second
 * ({@link executeRun}). Planning is synchronous and cheap: it decides the run
 * id, the working directory, the mode and sandbox, the prompt, and the argument
 * vector, and it creates the artifact directory. Executing starts the child
 * ({@link module:dsh-codex-peer/launch}), streams its event log into the
 * artifact files and a progress log, and folds everything into one outcome
 * record the tools can render.
 *
 * The child is a real `codex` process; the sandbox mode passed to Codex is the
 * only thing bounding what it may write, which is why the tool layer asks the
 * user before a mutating run.
 *
 * @module dsh-codex-peer/runner
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { buildExecArgv, buildPrompt } from './argv.js'
import { deriveSandbox } from './config.js'
import { createProgressLog, createStreamReader } from './events.js'
import { childEnv, createLaunch, managedEnvOverrides } from './launch.js'
import { createRunId, writeFileAtomic } from './ledger.js'
import { locateCodex } from './locate.js'
import { mirrorRun, workspacePaths, workspaceRoot } from './workspace.js'

/** @returns the first line of a prompt, clipped, for job labels and logs. */
export function promptLabel(prompt, limit = 72) {
  const line = String(prompt ?? '')
    .split('\n')
    .find((candidate) => candidate.trim() !== '')
  const text = line === undefined ? '' : line.trim()
  if (text === '') return '(empty request)'
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/**
 * Decide everything about a run except the process itself.
 *
 * @param peer - `{ config, ledger }`.
 * @param request - `{ prompt, mode?, sandbox?, model?, cwd?, continueFromLast?, resumeThreadId?, outputSchemaText?, extraArgs?, label? }`.
 * @param exec - the tool execution context, used for the session working directory.
 * @returns the plan: identity, resolved knobs, artifact paths, prompt, and argv.
 */
export function planRun(peer, request, exec) {
  const config = peer.config
  const cwd = String(request.cwd ?? exec?.agent?.session?.header?.cwd ?? process.cwd())
  const mode = request.mode ?? config.defaultMode
  const sandbox = deriveSandbox(config, mode, request.sandbox)
  const model = request.model ?? config.model ?? ''
  const explicitResume = request.resumeThreadId
  const resumeThreadId =
    explicitResume !== undefined && explicitResume !== null && String(explicitResume).trim() !== ''
      ? String(explicitResume).trim()
      : request.continueFromLast === true
        ? peer.ledger.lastThread(cwd)
        : undefined

  const runId = createRunId()
  peer.ledger.createRunDir(runId)
  const at = (file) => peer.ledger.runPath(runId, file)
  const promptPath = at('prompt.md')
  const eventsPath = at('events.jsonl')
  const stderrPath = at('stderr.txt')
  const answerPath = at('answer.md')
  const metaPath = at('meta.json')
  const schemaPath = at('output-schema.json')

  const prompt = buildPrompt({
    config,
    mode,
    cwd,
    prompt: request.prompt,
    resume: resumeThreadId,
    extraContext: request.extraContext,
  })
  const argv = buildExecArgv({
    sandbox,
    model,
    cwd,
    answerPath,
    outputSchemaPath: request.outputSchemaText === undefined ? undefined : schemaPath,
    resumeThreadId,
    extraArgs: Array.isArray(request.extraArgs) && request.extraArgs.length > 0 ? request.extraArgs : config.extraArgs,
  })

  writeFileAtomic(promptPath, prompt)
  if (request.outputSchemaText !== undefined) writeFileAtomic(schemaPath, `${String(request.outputSchemaText).trim()}\n`)

  // The human-readable mirror lives in the working tree; the artifact files above
  // stay in the state directory, which remains the record the plugin reads.
  const mirror = workspaceRoot(config, cwd)

  return {
    runId,
    label: request.label ?? `${mode} · ${promptLabel(request.prompt)}`,
    mode,
    sandbox,
    model,
    cwd,
    prompt,
    argv,
    resumedThreadId: resumeThreadId ?? null,
    outputSchemaPath: request.outputSchemaText === undefined ? undefined : schemaPath,
    workspace: mirror === undefined ? undefined : workspacePaths(mirror, runId),
    paths: { runDir: peer.ledger.runDir(runId), promptPath, eventsPath, stderrPath, answerPath, metaPath, schemaPath },
  }
}

/** @returns the answer file's text when Codex wrote one, else undefined. */
function readAnswerFile(path) {
  try {
    if (!existsSync(path) || statSync(path).size === 0) return undefined
    const text = readFileSync(path, 'utf8')
    return text.trim() === '' ? undefined : text
  } catch {
    return undefined
  }
}

/** Clip an answer to the configured budget, reporting whether it was clipped. */
function clipAnswer(text, maxBytes, answerPath) {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return { answer: text, truncated: false }
  const head = buffer.subarray(0, Math.max(1, maxBytes - 200)).toString('utf8')
  return {
    answer: `${head}\n\n[… answer truncated by dsh-codex-peer at ${maxBytes} bytes; the full message is in ${answerPath}]`,
    truncated: true,
  }
}

/**
 * Run the plan.
 *
 * @param peer - `{ config, ledger, subprocess?, logger? }`.
 * @param plan - the value {@link planRun} returned.
 * @param options - `signal`, `progress`, `spawnImpl`, `platform`, `env`, `onSpawn`.
 * @returns the outcome record described in the plugin README.
 */
export async function executeRun(peer, plan, options = {}) {
  const config = peer.config
  const platform = options.platform ?? process.platform
  const spawnImpl = options.spawnImpl
  const env = options.env ?? process.env
  const signal = options.signal
  const progress = options.progress ?? createProgressLog({ maxLines: config.progressKeepLines })
  const reader = createStreamReader({ progress, progressKeepLines: config.progressKeepLines })
  const notes = reader.report.notes

  const located = locateCodex(config, env)
  if (!located.available) {
    const considered = located.candidates.slice(0, 8).map((candidate) => `${candidate.path} (${candidate.source})`)
    throw new Error(
      `codex CLI not found. Set codexPath in the codex-peer plugin config, or install Codex. Considered: ${considered.join('; ')}`,
    )
  }

  const startedAt = new Date()
  const startedMs = Date.now()
  const launched = createLaunch({
    subprocess: peer.subprocess,
    executable: located.path,
    argv: plan.argv,
    cwd: plan.cwd,
    env: childEnv(config, env),
    envOverrides: managedEnvOverrides(config),
    stdinData: plan.prompt,
    graceMs: config.terminateGraceMs,
    signal,
    platform,
    spawnImpl: spawnImpl ?? spawn,
  })
  const launch = launched.launch
  if (launched.note !== undefined) notes.push(launched.note)
  if (launch.note !== undefined) notes.push(launch.note)

  let timedOut = false
  let aborted = false
  const append = (path, text) => {
    try {
      appendFileSync(path, text, 'utf8')
    } catch {
      // Artifact writing is best-effort; a run's result does not depend on it.
    }
  }

  progress.push(`codex ${plan.runId} · ${plan.mode}/${plan.sandbox} · ${launch.kind} launch · ${located.path}`)
  options.onSpawn?.({
    runId: plan.runId,
    runDir: plan.paths.runDir,
    argv: plan.argv,
    executable: located.path,
    launcher: launch.kind,
    pid: launch.pid,
  })

  launch.stdout?.on('data', (chunk) => {
    const text = chunk.toString('utf8')
    append(plan.paths.eventsPath, text)
    reader.push(text, 'stdout')
  })
  launch.stderr?.on('data', (chunk) => {
    const text = chunk.toString('utf8')
    append(plan.paths.stderrPath, text)
    reader.push(text, 'stderr')
  })
  launch.stdin?.on('error', () => {
    // A prompt that fails to write surfaces as a normal non-zero exit.
  })

  const kill = (reason) => {
    notes.push(reason)
    progress.push(reason)
    try {
      launch.terminate()
    } catch (error) {
      notes.push(`failed to terminate the Codex process: ${error?.message ?? String(error)}`)
    }
  }

  const runTimer = setTimeout(() => {
    timedOut = true
    kill(`run exceeded runTimeoutMs (${config.runTimeoutMs} ms); the Codex process tree was terminated`)
  }, config.runTimeoutMs)

  const onAbort = () => {
    aborted = true
    kill('the tool call was aborted; the Codex process tree was terminated')
  }
  if (signal !== undefined && signal !== null) signal.addEventListener('abort', onAbort, { once: true })

  if (launch.stdinFed !== true && launch.stdin !== undefined) {
    try {
      launch.stdin.end(plan.prompt)
    } catch (error) {
      notes.push(`failed to write the prompt to codex stdin: ${error?.message ?? String(error)}`)
      kill('the prompt could not be delivered; the Codex process tree was terminated')
    }
  }

  let exit = null
  let failure = null
  try {
    exit = await launch.done
  } catch (error) {
    failure = error
  } finally {
    clearTimeout(runTimer)
    if (signal !== undefined && signal !== null) signal.removeEventListener('abort', onAbort)
  }

  reader.flush()
  const endedAt = new Date()
  const durationMs = Date.now() - startedMs
  const report = reader.report
  const exitCode = exit?.exitCode ?? null
  const exitSignal = exit?.signal ?? null
  const fromFile = readAnswerFile(plan.paths.answerPath)
  const rawAnswer = fromFile ?? report.answer
  if (fromFile !== undefined && report.answer !== '' && fromFile.trim() !== report.answer.trim()) {
    notes.push('the event stream and the -o answer file disagreed; the answer file was used')
  }
  const clip = clipAnswer(String(rawAnswer ?? ''), Math.max(1000, config.maxAnswerBytes), plan.paths.answerPath)
  const status = failure !== null ? 'failed' : aborted ? 'aborted' : timedOut ? 'timeout' : exitCode === 0 ? 'completed' : 'failed'
  if (failure !== null) notes.push(`the Codex process could not be run: ${failure?.message ?? String(failure)}`)
  else if (status === 'failed') notes.push(`codex exited with code ${String(exitCode)}`)

  const outcome = {
    status,
    runId: plan.runId,
    runDir: plan.paths.runDir,
    mode: plan.mode,
    sandbox: plan.sandbox,
    model: plan.model,
    cwd: plan.cwd,
    launcher: launch.kind,
    resumedThreadId: plan.resumedThreadId,
    threadId: report.threadId,
    answer: clip.answer,
    truncated: clip.truncated,
    answerPath: plan.paths.answerPath,
    eventsPath: plan.paths.eventsPath,
    stderrPath: plan.paths.stderrPath,
    report,
    usage: report.usage,
    commands: report.commands,
    fileChanges: report.fileChanges,
    errors: report.errors,
    notes,
    progress: progress.text(),
    exitCode,
    signal: exitSignal,
    durationMs,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    argv: [located.path, ...plan.argv],
    executable: located.path,
  }

  try {
    writeFileAtomic(
      plan.paths.metaPath,
      `${JSON.stringify(
        {
          runId: outcome.runId,
          mode: outcome.mode,
          sandbox: outcome.sandbox,
          model: outcome.model,
          cwd: outcome.cwd,
          launcher: outcome.launcher,
          resumedThreadId: outcome.resumedThreadId,
          threadId: outcome.threadId,
          status: outcome.status,
          exitCode: outcome.exitCode,
          signal: outcome.signal,
          durationMs: outcome.durationMs,
          startedAt: outcome.startedAt,
          endedAt: outcome.endedAt,
          usage: outcome.usage,
          commands: outcome.commands,
          fileChanges: outcome.fileChanges,
          errors: outcome.errors,
          notes: outcome.notes,
          truncated: outcome.truncated,
          argv: outcome.argv,
        },
        null,
        2,
      )}\n`,
    )
  } catch {
    notes.push('the run metadata file could not be written')
  }

  // A readable copy for the person watching the working tree. Best-effort: the
  // run's outcome never depends on it.
  if (plan.workspace !== undefined) {
    try {
      const mirrored = mirrorRun({
        root: plan.workspace.root,
        runId: plan.runId,
        plan,
        outcome,
        tasks: peer.tasks === undefined ? undefined : peer.tasks.list(),
        now: outcome.endedAt,
      })
      outcome.workspace = mirrored
      progress.push(`workspace copy written to ${mirrored.latest}`)
    } catch (error) {
      notes.push(`the workspace copy could not be written: ${error?.message ?? String(error)}`)
    }
  }

  try {
    if (typeof outcome.threadId === 'string' && outcome.threadId !== '') peer.ledger.setLastThread(plan.cwd, outcome.threadId)
    peer.ledger.appendRun({
      runId: outcome.runId,
      startedAt: outcome.startedAt,
      endedAt: outcome.endedAt,
      durationMs: outcome.durationMs,
      mode: outcome.mode,
      sandbox: outcome.sandbox,
      model: outcome.model ?? '',
      cwd: outcome.cwd,
      launcher: outcome.launcher,
      status: outcome.status,
      exitCode: outcome.exitCode,
      threadId: outcome.threadId ?? null,
      resumedThreadId: outcome.resumedThreadId,
      usage: outcome.usage,
      answerChars: outcome.answer.length,
      truncated: outcome.truncated,
      label: plan.label,
    })
  } catch {
    notes.push('the run index could not be appended')
  }

  return outcome
}

/**
 * A one-line, model-facing description of an outcome.
 * @param outcome - an outcome record.
 * @returns the description used in tool result text.
 */
export function describeOutcome(outcome) {
  const usage = outcome.usage === null ? '' : ` · ${outcome.usage.totalTokens} tokens`
  const thread = outcome.threadId === null ? '' : ` · thread ${outcome.threadId}`
  const resume = outcome.resumedThreadId === null ? '' : ` (resumed ${outcome.resumedThreadId})`
  const parts = [`status ${outcome.status}${resume}${thread}${usage}`, `${(outcome.durationMs / 1000).toFixed(1)}s`]
  if (outcome.notes.length > 0) parts.push(outcome.notes.join('; '))
  return parts.join(' · ')
}
