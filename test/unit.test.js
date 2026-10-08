/**
 * Unit tests for dsh-codex-peer.
 *
 * Everything here is deterministic and offline: no Codex process, no network,
 * no dependence on what is installed on the machine. The one place a process
 * could have started (`executeRun`) gets a fake `spawnImpl`, and the "which
 * executable" question is answered with a file the test creates itself.
 *
 * Run with `node --test test/` or, to avoid the test runner's child processes,
 * directly: `node test/unit.test.js`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_PREAMBLE, buildExecArgv, buildPrompt, modeInstruction } from '../lib/argv.js'
import { Config, defaultStateDir, deriveSandbox, resolveStateDir } from '../lib/config.js'
import { createProgressLog, createStreamReader, formatUsage, parseEventLine } from '../lib/events.js'
import { createApprovalGate, needsApproval, planNeedsApproval } from '../lib/gate.js'
import { childEnv, managedEnvOverrides } from '../lib/launch.js'
import { createLedger, createRunId, normalizeCwd } from '../lib/ledger.js'
import { locateCodex } from '../lib/locate.js'
import { countFindings, normalizeReview, parseLooseJson } from '../lib/review.js'
import { executeRun, planRun, promptLabel } from '../lib/runner.js'
import { codexAskTool, codexStatusTool, registerTools, renderAskResult, renderReviewResult, renderStatusResult } from '../lib/tools.js'
import { toJsonValue } from '../lib/json.js'
import { PLAN_SCHEMA, ROUTING_DEFAULTS, buildPlanPrompt, expandMode, renderPlanMarkdown, renderTaskLine, routeTask } from '../lib/plan.js'
import { codexPlanTool, codexTaskTool, renderPlanResult, renderTaskResult, taskView } from '../lib/planning-tools.js'
import { createTaskStore } from '../lib/tasks.js'

/** @returns a fresh temp directory the test owns and removes. */
function tempDir(name) {
  return mkdtempSync(join(tmpdir(), `codex-peer-test-${name}-`))
}

/** @returns a validated config object. */
function config(overrides = {}) {
  return Config(overrides)
}

/** @returns a peer object with a real ledger in `dir`. */
function peer(config, dir) {
  return { config, ledger: createLedger({ dir }) }
}

/** The JSONL a real `codex exec --json` run produces, trimmed to one of each item. */
const SAMPLE_STREAM = [
  '{"type":"thread.started","thread_id":"01a11ad4-e64b-7eb3-98d1-d07e40e47246"}',
  '{"type":"turn.started"}',
  '{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"git status --short","status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"git status --short","exit_code":0,"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"file_change","changes":[{"kind":"update","path":"lib/a.js"}]}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"todo_list","items":[{"text":"one"},{"text":"two"}]}}',
  '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"PEER_OK"}}',
  '{"type":"turn.completed","usage":{"input_tokens":22406,"cached_input_tokens":13184,"cache_write_input_tokens":0,"output_tokens":7,"reasoning_output_tokens":0}}',
  '',
].join('\n')

/** @returns a fake child process that streams `stream` on stdout and exits with `code`. */
function fakeChildProcess(stream, code = 0) {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.pid = 4242
  child.kill = () => true
  setImmediate(() => {
    child.stdout.write(stream)
    child.stdout.end()
    child.stderr.end()
    child.emit('close', code, null)
  })
  return child
}

test('config defaults cover every knob the tools read', () => {
  const value = config()
  assert.equal(value.defaultMode, 'ask')
  assert.equal(value.defaultSandbox, '')
  assert.equal(value.requireApproval, 'mutating')
  assert.equal(value.callTimeoutMs, 600000)
  assert.equal(value.runTimeoutMs, 1800000)
  assert.equal(value.terminateGraceMs, 5000)
  assert.equal(value.maxAnswerBytes, 120000)
  assert.deepEqual(value.extraArgs, [])
  assert.equal(value.codexHome, '')
  assert.equal(value.stateDir, '')
})

test('config validation rejects values outside the declared vocabulary', () => {
  assert.throws(() => config({ defaultMode: 'deploy' }))
  assert.throws(() => config({ requireApproval: 'sometimes' }))
  assert.throws(() => config({ callTimeoutMs: 10 }))
})

test('deriveSandbox makes implement writable and everything else read-only', () => {
  const value = config()
  assert.equal(deriveSandbox(value, 'implement', undefined), 'workspace-write')
  assert.equal(deriveSandbox(value, 'plan', undefined), 'read-only')
  assert.equal(deriveSandbox(value, 'ask', undefined), 'read-only')
  assert.equal(deriveSandbox(value, 'ask', 'danger-full-access'), 'danger-full-access')
  assert.equal(deriveSandbox(config({ defaultSandbox: 'workspace-write' }), 'plan', undefined), 'workspace-write')
})

test('the state directory follows DSH_HOME unless configured', () => {
  const env = { DSH_HOME: join('C:', 'dsh-home') }
  assert.equal(defaultStateDir(env), join('C:', 'dsh-home', 'codex-peer'))
  assert.equal(resolveStateDir(config(), env), join('C:', 'dsh-home', 'codex-peer'))
  assert.equal(resolveStateDir(config({ stateDir: join('C:', 'custom') }), env), join('C:', 'custom'))
})

test('a fresh run argv pins cwd and sandbox and takes its prompt on stdin', () => {
  const argv = buildExecArgv({ sandbox: 'read-only', model: '', cwd: 'C:\\work', answerPath: 'C:\\a.md', resumeThreadId: undefined, extraArgs: [] })
  assert.equal(argv[0], 'exec')
  assert.ok(argv.includes('--json'))
  assert.ok(argv.includes('--skip-git-repo-check'))
  assert.deepEqual(argv.slice(argv.indexOf('-C'), argv.indexOf('-C') + 2), ['-C', 'C:\\work'])
  assert.deepEqual(argv.slice(argv.indexOf('-s'), argv.indexOf('-s') + 2), ['-s', 'read-only'])
  assert.deepEqual(argv.slice(argv.indexOf('-o'), argv.indexOf('-o') + 2), ['-o', 'C:\\a.md'])
  assert.ok(!argv.includes('-m'))
  assert.ok(!argv.includes('resume'))
  assert.equal(argv.at(-1), '-')
})

test('a resumed run argv avoids -C and -s, which codex exec resume rejects', async () => {
  const argv = buildExecArgv({
    sandbox: 'workspace-write',
    model: 'gpt-6-astra',
    cwd: 'C:\\work',
    answerPath: undefined,
    outputSchemaPath: 'C:\\schema.json',
    resumeThreadId: 'thr-1',
    extraArgs: ['--ephemeral'],
  })
  assert.deepEqual(argv.slice(0, 3), ['exec', 'resume', 'thr-1'])
  assert.ok(!argv.includes('-C'))
  assert.ok(!argv.includes('-s'))
  assert.deepEqual(argv.slice(argv.indexOf('-c'), argv.indexOf('-c') + 2), ['-c', 'sandbox_mode="workspace-write"'])
  assert.deepEqual(argv.slice(argv.indexOf('-m'), argv.indexOf('-m') + 2), ['-m', 'gpt-6-astra'])
  assert.deepEqual(argv.slice(argv.indexOf('--output-schema'), argv.indexOf('--output-schema') + 2), ['--output-schema', 'C:\\schema.json'])
  assert.ok(argv.includes('--ephemeral'))
  assert.equal(argv.at(-1), '-')
})

test('the prompt is a collaboration contract plus the request', () => {
  const prompt = buildPrompt({ config: config(), mode: 'plan', cwd: 'C:\\work', prompt: 'Design the migration', resume: undefined })
  assert.ok(prompt.includes(DEFAULT_PREAMBLE))
  assert.ok(prompt.includes(modeInstruction('plan')))
  assert.ok(prompt.includes('C:\\work'))
  assert.ok(prompt.includes('--- request ---'))
  assert.ok(prompt.trimEnd().endsWith('Design the migration'))
  assert.ok(prompt.endsWith('\n'))
})

test('a resumed prompt tells Codex the thread continues', () => {
  const prompt = buildPrompt({ config: config(), mode: 'ask', cwd: 'C:\\work', prompt: 'keep going', resume: 'thr-9' })
  assert.ok(prompt.includes('continues thread thr-9'))
})

test('a configured preamble replaces the built-in one', () => {
  const prompt = buildPrompt({ config: config({ promptPreamble: 'Custom contract.' }), mode: 'ask', cwd: 'C:\\w', prompt: 'x' })
  assert.ok(prompt.startsWith('Custom contract.'))
  assert.ok(!prompt.includes(DEFAULT_PREAMBLE))
})

test('the event reader folds a JSONL stream into a report, splitting mid-line', () => {
  const progress = createProgressLog({ maxLines: 50 })
  const reader = createStreamReader({ progress })
  const mid = 137
  reader.push(SAMPLE_STREAM.slice(0, mid), 'stdout')
  reader.push(SAMPLE_STREAM.slice(mid), 'stdout')
  reader.push('WARNING: noise on stderr\n', 'stderr')
  reader.flush()

  const report = reader.report
  assert.equal(report.threadId, '01a11ad4-e64b-7eb3-98d1-d07e40e47246')
  assert.equal(report.answer, 'PEER_OK')
  assert.equal(report.answerSeen, 1)
  assert.deepEqual(report.commands, [{ command: 'git status --short', exitCode: 0, status: 'completed' }])
  assert.deepEqual(report.fileChanges, ['update lib/a.js'])
  assert.equal(report.todos.length, 2)
  assert.equal(report.usage.totalTokens, 22413)
  assert.equal(report.usage.cachedInputTokens, 13184)
  assert.equal(report.parseErrors, 0)
  assert.equal(report.eventCount, 8)
  assert.ok(progress.text().includes('stderr: WARNING: noise on stderr'))
  assert.ok(progress.text().includes('$ git status --short → exit 0'))
})

test('a malformed stdout line is counted, not thrown', () => {
  const reader = createStreamReader({})
  reader.push('this is not json\n', 'stdout')
  reader.push('{"type":"turn.completed","usage":{}}\n', 'stdout')
  reader.flush()
  assert.equal(reader.report.parseErrors, 1)
  assert.equal(reader.report.usage.totalTokens, 0)
})

test('parseEventLine separates events from raw text', () => {
  assert.deepEqual(parseEventLine('{"type":"turn.started"}'), { event: { type: 'turn.started' } })
  assert.deepEqual(parseEventLine('plain text'), { raw: 'plain text' })
  assert.deepEqual(parseEventLine('   '), { raw: '' })
  assert.deepEqual(parseEventLine('42'), { raw: '42' })
})

test('formatUsage reports cached and reasoning tokens only when present', () => {
  assert.equal(formatUsage({ inputTokens: 10, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 }), 'tokens: in 10 · out 2')
  assert.equal(
    formatUsage({ inputTokens: 10, cachedInputTokens: 8, outputTokens: 2, reasoningOutputTokens: 1 }),
    'tokens: in 10, cached 8 · out 2, reasoning 1',
  )
})

test('the progress log reads from an offset without consuming', () => {
  const progress = createProgressLog({ maxLines: 10 })
  progress.push('first line')
  const first = progress.read(0)
  assert.ok(first.text.includes('first line'))
  const again = progress.read(0)
  assert.equal(again.text, first.text)
  progress.push('second line')
  const rest = progress.read(first.nextOffset)
  assert.ok(rest.text.includes('second line'))
  assert.ok(!rest.text.includes('first line'))
  assert.equal(progress.trimmedLines(), 0)
})

test('parseLooseJson accepts bare, fenced and prose-wrapped objects', () => {
  assert.deepEqual(parseLooseJson('{"verdict":"pass"}'), { verdict: 'pass' })
  assert.deepEqual(parseLooseJson('Here is the review:\n```json\n{"verdict":"pass"}\n```\n'), { verdict: 'pass' })
  assert.deepEqual(parseLooseJson('prefix {"a":{"b":2}} suffix'), { a: { b: 2 } })
  assert.ok(parseLooseJson('no json here') == null)
})

test('normalizeReview repairs severities, sorts findings and does not pass a blocker', () => {
  const value = normalizeReview(
    {
      findings: [
        { severity: 'nit', title: 'n', file: null, line: null, detail: 'd', suggestion: null },
        { severity: 'weird', title: 'w', file: 'a.js', line: 3, detail: 'd', suggestion: 'fix it' },
        { severity: 'blocker', title: 'b', file: 'b.js', line: 1, detail: 'd', suggestion: null },
      ],
    },
    'raw',
  )
  assert.equal(value.structured, true)
  assert.deepEqual(value.findings.map((finding) => finding.severity), ['blocker', 'major', 'nit'])
  assert.notEqual(value.verdict, 'pass')
  assert.ok(value.notes.length >= 1)
  assert.deepEqual(countFindings(value.findings), { blocker: 1, major: 1, minor: 0, nit: 1, total: 3 })
})

test('normalizeReview marks prose answers unstructured', () => {
  const value = normalizeReview(parseLooseJson('I could not review this.'), 'I could not review this.')
  assert.equal(value.structured, false)
  assert.deepEqual(value.findings, [])
  assert.equal(typeof value.summary, 'string')
})

test('the ledger creates run directories, indexes runs and remembers threads', () => {
  const dir = tempDir('ledger')
  try {
    const ledger = createLedger({ dir })
    ledger.ensure()
    const runId = createRunId()
    assert.match(runId, /^codex-\d{8}-\d{6}-[0-9a-f]+$/)

    ledger.createRunDir(runId)
    const promptPath = ledger.runPath(runId, 'prompt.md')
    writeFileSync(promptPath, 'hello', 'utf8')
    assert.equal(readFileSync(promptPath, 'utf8'), 'hello')

    ledger.setLastThread('C:\\Work\\Repo', 'thr-1')
    assert.equal(ledger.lastThread('c:\\work\\repo\\'), 'thr-1')
    assert.equal(ledger.lastThread('C:\\other') ?? null, null)

    ledger.appendRun({
      runId,
      startedAt: '2026-10-08T10:00:00.000Z',
      endedAt: '2026-10-08T10:00:04.000Z',
      durationMs: 4000,
      mode: 'implement',
      sandbox: 'workspace-write',
      model: '',
      cwd: 'C:\\Work\\Repo',
      launcher: 'subprocess',
      status: 'completed',
      exitCode: 0,
      threadId: 'thr-1',
      resumedThreadId: null,
      usage: null,
      answerChars: 12,
      truncated: false,
      label: 'implement · do the thing',
    })
    const runs = ledger.listRuns(5)
    assert.equal(runs.length, 1)
    assert.equal(runs[0].runId, runId)
    assert.equal(runs[0].mode, 'implement')
    assert.ok(ledger.listThreads().some((thread) => thread.threadId === 'thr-1'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('normalizeCwd ignores case and trailing separators', () => {
  assert.equal(normalizeCwd('C:\\Work\\Repo\\'), normalizeCwd('c:\\work\\repo'))
})

test('needsApproval asks before anything that may write', () => {
  assert.equal(needsApproval('never', { mode: 'implement', sandbox: 'workspace-write' }), false)
  assert.equal(needsApproval('always', { mode: 'ask', sandbox: 'read-only' }), true)
  assert.equal(needsApproval('mutating', { mode: 'implement', sandbox: 'read-only' }), true)
  assert.equal(needsApproval('mutating', { mode: 'ask', sandbox: 'workspace-write' }), true)
  assert.equal(needsApproval('mutating', { mode: 'ask', sandbox: 'danger-full-access' }), true)
  assert.equal(needsApproval('mutating', { mode: 'ask', sandbox: 'read-only' }), false)
  assert.equal(needsApproval('mutating', { mode: 'plan', sandbox: 'read-only' }), false)
})

test('the gate asks for an implement call and passes read-only calls through', () => {
  const gate = createApprovalGate(peer(config(), tempDir('gate')))
  let passed = 0
  const next = () => {
    passed += 1
    return { kind: 'allow' }
  }

  const asked = gate({ name: 'codex_ask', arguments: { prompt: 'x', mode: 'implement' }, agent: { session: { header: { cwd: 'C:\\work' } } } }, next)
  assert.equal(asked.kind, 'ask')
  assert.ok(asked.reason.includes('C:\\work'))
  assert.ok(asked.displayReason.includes('implement'))
  assert.equal(passed, 0)

  assert.equal(gate({ name: 'codex_ask', arguments: { prompt: 'x', mode: 'ask' } }, next).kind, 'allow')
  assert.equal(gate({ name: 'codex_review', arguments: { target: 'working-tree' } }, next).kind, 'allow')
  assert.equal(gate({ name: 'bash', arguments: { command: 'ls' } }, next).kind, 'allow')
  assert.equal(gate(undefined, next).kind, 'allow')
  assert.equal(passed, 4)
})

test('the gate honours requireApproval: always and never', () => {
  const always = createApprovalGate(peer(config({ requireApproval: 'always' }), tempDir('gate-always')))
  assert.equal(always({ name: 'codex_ask', arguments: { prompt: 'x' } }, () => ({ kind: 'allow' })).kind, 'ask')
  const never = createApprovalGate(peer(config({ requireApproval: 'never' }), tempDir('gate-never')))
  assert.equal(never({ name: 'codex_ask', arguments: { prompt: 'x', mode: 'implement' } }, () => ({ kind: 'allow' })).kind, 'allow')
})

test('codex_ask declares a required prompt and no other required field', () => {
  const tool = codexAskTool(peer(config(), tempDir('tool-ask')))
  assert.equal(tool.name, 'codex_ask')
  assert.deepEqual(tool.parameters.required, ['prompt'])
  assert.equal(tool.parameters.additionalProperties, false)
  assert.deepEqual(tool.parameters.properties.mode.enum, ['ask', 'plan', 'implement'])
  assert.deepEqual(tool.parameters.properties.sandbox.enum, ['read-only', 'workspace-write', 'danger-full-access'])
  assert.equal(tool.parameters.properties.prompt.type, 'string')
  assert.equal(typeof tool.execute, 'function')
  assert.equal(tool.output.schema.type, 'object')
})

test('registerTools registers every tool and disposes them', () => {
  const registered = []
  const ctx = { tools: { register: (tool) => { registered.push(tool.name); return () => registered.push(`disposed:${tool.name}`) } } }
  const dispose = registerTools(ctx, peer(config(), tempDir('tools')))
  assert.deepEqual(registered, ['codex_ask', 'codex_review', 'codex_status', 'codex_plan', 'codex_task'])
  dispose()
  assert.equal(registered.length, 10)
})

test('an ask result renders the answer, the evidence and the artifacts', () => {
  const text = renderAskResult({
    status: 'completed',
    mode: 'implement',
    sandbox: 'workspace-write',
    runId: 'codex-20261008-101010-abcd',
    runDir: 'C:\\state\\runs\\codex-20261008-101010-abcd',
    threadId: 'thr-1',
    resumedThreadId: null,
    usage: { totalTokens: 1234 },
    durationMs: 2500,
    answer: 'I changed lib/a.js.',
    commands: [{ command: 'npm test', exitCode: 0 }],
    fileChanges: ['update lib/a.js'],
    errors: [],
    notes: ['run exceeded runTimeoutMs'],
    artifacts: { answer: 'C:\\state\\answer.md' },
  })
  assert.ok(text.startsWith('codex implement · completed'))
  assert.ok(text.includes('I changed lib/a.js.'))
  assert.ok(text.includes('$ npm test → exit 0'))
  assert.ok(text.includes('files: update lib/a.js'))
  assert.ok(text.includes('note: run exceeded runTimeoutMs'))
})

test('a promoted run renders a job handle instead of an answer', () => {
  const text = renderAskResult({
    status: 'running',
    mode: 'implement',
    jobId: 'job-7',
    runId: 'codex-20261008-101010-abcd',
    runDir: 'C:\\state\\runs\\x',
    progressTail: 'thread thr-1 started',
    artifacts: { answer: 'C:\\state\\answer.md' },
  })
  assert.ok(text.includes('background job job-7'))
  assert.ok(text.includes('job_output'))
  assert.ok(text.includes('thread thr-1 started'))
})

test('a review result renders verdict, findings and counts', () => {
  const text = renderReviewResult({
    status: 'completed',
    structured: true,
    review: {
      verdict: 'concerns',
      summary: 'Two issues worth fixing.',
      findings: [
        { severity: 'blocker', title: 'Leaks a handle', file: 'lib/a.js', line: 12, detail: 'not closed', suggestion: 'use try/finally' },
        { severity: 'major', title: 'Missing test', file: null, line: null, detail: 'no coverage', suggestion: null },
      ],
    },
    run: {
      status: 'completed',
      mode: 'review',
      threadId: 'thr-2',
      resumedThreadId: null,
      usage: { totalTokens: 900 },
      durationMs: 1000,
      runId: 'codex-1',
      runDir: 'C:\\state\\runs\\codex-1',
      answerPath: 'C:\\state\\runs\\codex-1\\answer.md',
      commands: [],
      fileChanges: [],
      errors: [],
      notes: [],
    },
  })
  assert.ok(text.startsWith('codex review · concerns · 2 finding(s) (1 blocker, 1 major, 0 minor, 0 nit)'))
  assert.ok(text.includes('[blocker] Leaks a handle (lib/a.js:12)'))
  assert.ok(text.includes('suggestion: use try/finally'))
  assert.ok(text.includes('Two issues worth fixing.'))
})

test('a status result names the state directory and the codex it found', () => {
  const text = renderStatusResult({
    stateDir: 'C:\\state',
    codex: { available: true, path: 'C:\\codex.exe', source: 'configuration', version: 'codex-cli 0.155.0' },
    config: { defaultMode: 'ask', defaultSandbox: '(derived from mode)', model: '', requireApproval: 'mutating', callTimeoutMs: 600000, runTimeoutMs: 1800000 },
    runs: [{ startedAt: '2026-10-08T10:00:00.000Z', status: 'completed', mode: 'ask', sandbox: 'read-only', durationMs: 1000, usage: { totalTokens: 100 }, runId: 'codex-1', cwd: 'C:\\work' }],
    threads: [{ cwd: 'C:\\work', threadId: 'thr-1' }],
  })
  assert.ok(text.includes('C:\\state'))
  assert.ok(text.includes('C:\\codex.exe · codex-cli 0.155.0'))
  assert.ok(text.includes('codex-1'))
  assert.ok(text.includes('C:\\work → thr-1'))
})

test('locateCodex reports every candidate it considered when Codex is absent', () => {
  const empty = tempDir('locate')
  try {
    const located = locateCodex(config({ codexPath: join(empty, 'missing.exe'), codexHome: empty }), {
      LOCALAPPDATA: empty,
      APPDATA: empty,
      PATH: empty,
      CODEX_HOME: empty,
    })
    assert.equal(located.available, false)
    assert.ok(located.candidates.length >= 1)
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

test('locateCodex finds a configured executable', () => {
  const dir = tempDir('locate-hit')
  try {
    const executable = join(dir, 'codex.exe')
    writeFileSync(executable, '')
    const located = locateCodex(config({ codexPath: executable }), { LOCALAPPDATA: dir, APPDATA: dir, PATH: dir, CODEX_HOME: dir })
    assert.equal(located.available, true)
    assert.equal(located.path, executable)
    assert.equal(located.source, 'config.codexPath')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('childEnv passes the parent environment through and adds CODEX_HOME only when configured', () => {
  const base = { PATH: 'C:\\x' }
  assert.equal(childEnv(config(), base).CODEX_HOME, undefined)
  const configured = childEnv(config({ codexHome: 'C:\\codexhome' }), base)
  assert.equal(configured.CODEX_HOME, 'C:\\codexhome')
  assert.equal(configured.PATH, 'C:\\x')
  assert.equal(base.CODEX_HOME, undefined)
  assert.equal(managedEnvOverrides(config()), undefined)
  assert.deepEqual(managedEnvOverrides(config({ codexHome: 'C:\\codexhome' })), { CODEX_HOME: 'C:\\codexhome' })
})

test('promptLabel clips the first non-empty line', () => {
  assert.equal(promptLabel('\n\n  Do the thing  \nmore'), 'Do the thing')
  assert.equal(promptLabel(''), '(empty request)')
  assert.equal(promptLabel('x'.repeat(100)).length, 72)
})

test('planRun writes the prompt and schema and builds the artifact paths', () => {
  const dir = tempDir('plan')
  try {
    const plan = planRun(peer(config(), dir), { prompt: 'Refactor the loader', mode: 'plan', cwd: 'C:\\work', outputSchemaText: '{"type":"object"}' }, undefined)
    assert.match(plan.runId, /^codex-/)
    assert.equal(plan.mode, 'plan')
    assert.equal(plan.sandbox, 'read-only')
    assert.equal(plan.cwd, 'C:\\work')
    assert.equal(plan.argv.at(-1), '-')
    assert.ok(plan.argv.includes('exec'))
    assert.equal(readFileSync(plan.paths.promptPath, 'utf8').includes('Refactor the loader'), true)
    assert.equal(readFileSync(plan.paths.schemaPath, 'utf8').trim(), '{"type":"object"}')
    assert.ok(plan.paths.runDir.startsWith(dir))
    assert.ok(existsSync(plan.paths.runDir))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('planRun continues the thread remembered for the working directory', () => {
  const dir = tempDir('plan-resume')
  try {
    const subject = peer(config(), dir)
    subject.ledger.ensure()
    subject.ledger.setLastThread('C:\\work', 'thr-remembered')
    const plan = planRun(subject, { prompt: 'continue', mode: 'ask', cwd: 'C:\\work', continueFromLast: true }, undefined)
    assert.equal(plan.resumedThreadId, 'thr-remembered')
    assert.deepEqual(plan.argv.slice(0, 3), ['exec', 'resume', 'thr-remembered'])
    assert.ok(!plan.argv.includes('-C'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('executeRun folds a real event stream into an outcome and records the run', async () => {
  const dir = tempDir('execute')
  try {
    const executable = join(dir, 'codex.exe')
    writeFileSync(executable, '')
    const subject = peer(config({ codexPath: executable, maxAnswerBytes: 1000 }), dir)
    subject.ledger.ensure()
    const plan = planRun(subject, { prompt: 'Do it', mode: 'implement', cwd: dir }, undefined)
    let spawned = null
    const outcome = await executeRun(subject, plan, {
      platform: 'linux',
      env: { PATH: dir },
      spawnImpl: (command, argv, options) => {
        spawned = { command, argv, options }
        return fakeChildProcess(SAMPLE_STREAM, 0)
      },
    })

    assert.equal(spawned.command, executable)
    assert.equal(spawned.options.cwd, dir)
    assert.equal(spawned.options.stdio[0], 'pipe')
    assert.equal(outcome.status, 'completed')
    assert.equal(outcome.exitCode, 0)
    assert.equal(outcome.answer, 'PEER_OK')
    assert.equal(outcome.threadId, '01a11ad4-e64b-7eb3-98d1-d07e40e47246')
    assert.equal(outcome.usage.totalTokens, 22413)
    assert.equal(outcome.launcher, 'direct')
    assert.equal(outcome.commands.length, 1)
    assert.deepEqual(outcome.fileChanges, ['update lib/a.js'])
    assert.ok(existsSync(outcome.answerPath) === false)

    const meta = JSON.parse(readFileSync(plan.paths.metaPath, 'utf8'))
    assert.equal(meta.runId, plan.runId)
    assert.equal(meta.status, 'completed')
    assert.equal(meta.usage.totalTokens, 22413)

    const runs = subject.ledger.listRuns(5)
    assert.equal(runs.length, 1)
    assert.equal(runs[0].runId, plan.runId)
    assert.equal(subject.ledger.lastThread(dir), '01a11ad4-e64b-7eb3-98d1-d07e40e47246')
    assert.ok(readFileSync(plan.paths.eventsPath, 'utf8').includes('PEER_OK'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('executeRun reports a non-zero exit as failed', async () => {
  const dir = tempDir('execute-fail')
  try {
    const executable = join(dir, 'codex.exe')
    writeFileSync(executable, '')
    const subject = peer(config({ codexPath: executable }), dir)
    subject.ledger.ensure()
    const plan = planRun(subject, { prompt: 'Do it', mode: 'ask', cwd: dir }, undefined)
    const outcome = await executeRun(subject, plan, {
      platform: 'linux',
      env: { PATH: dir },
      spawnImpl: () => fakeChildProcess('', 3),
    })
    assert.equal(outcome.status, 'failed')
    assert.equal(outcome.exitCode, 3)
    assert.ok(outcome.notes.some((note) => note.includes('exited with code 3')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('executeRun refuses to guess when no Codex executable exists', async () => {
  const dir = tempDir('execute-missing')
  try {
    const subject = peer(config({ codexPath: join(dir, 'nope.exe'), codexHome: dir }), dir)
    subject.ledger.ensure()
    const plan = planRun(subject, { prompt: 'Do it', mode: 'ask', cwd: dir }, undefined)
    await assert.rejects(
      executeRun(subject, plan, { platform: 'linux', env: { LOCALAPPDATA: dir, APPDATA: dir, PATH: dir, CODEX_HOME: dir }, spawnImpl: () => fakeChildProcess('', 0) }),
      /codex CLI not found/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('codex_status reports the resolved setup without spawning anything', async () => {
  const dir = tempDir('status')
  try {
    const executable = join(dir, 'codex.exe')
    writeFileSync(executable, '')
    const subject = peer(config({ codexPath: executable }), dir)
    subject.ledger.ensure()
    const tool = codexStatusTool(subject)
    const value = await tool.execute({ limit: 5, cwd: 'C:\\work' }, { agent: { session: { header: { cwd: 'C:\\work' } } } })
    assert.equal(value.status, 'ok')
    assert.equal(value.stateDir, dir)
    assert.equal(value.codex.available, true)
    assert.equal(value.codex.path, executable)
    assert.equal(value.config.requireApproval, 'mutating')
    assert.deepEqual(value.runs, [])
    assert.equal(value.session.cwd, 'C:\\work')
    assert.ok(renderStatusResult(value).includes(dir))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the work list hands out stable ids and keeps a history', () => {
  const dir = tempDir('tasks')
  try {
    const store = createTaskStore({ dir })
    const created = store.createMany([{ title: 'Ship the docs' }, { title: 'Bulk rename', tags: ['bulk'] }], {
      mode: 'assigned',
      approvedAt: '2026-10-08T00:00:00.000Z',
    })
    assert.deepEqual(created.map((task) => task.id), ['task-1', 'task-2'])
    assert.equal(created[0].status, 'todo')
    assert.equal(created[0].approvedAt, '2026-10-08T00:00:00.000Z')
    assert.equal(store.get('task-1').title, 'Ship the docs')
    assert.equal(store.list().length, 2)
    assert.equal(store.list({ status: 'todo' }).length, 2)
    assert.equal(existsSync(store.historyPath), true)
    assert.equal(readFileSync(store.historyPath, 'utf8').trim().split('\n').length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a task cannot be called done without evidence', () => {
  const dir = tempDir('tasks-done')
  try {
    const store = createTaskStore({ dir })
    store.createMany([{ title: 'x' }], { mode: 'assigned' })
    assert.throws(() => store.update('task-1', { status: 'done' }), /cannot be marked done without evidence/)
    assert.throws(() => store.update('task-1', { status: 'unverified' }), /needs a note/)
    assert.throws(() => store.update('nope', { status: 'doing' }), /unknown task/)
    assert.throws(() => store.update('task-1', { status: 'finished' }), /unknown status/)
    store.recordEvidence('task-1', { kind: 'command', what: 'npm test', result: 'pass' })
    const done = store.update('task-1', { status: 'done' })
    assert.equal(done.status, 'done')
    assert.equal(done.evidence.length, 1)
    assert.throws(() => store.recordEvidence('task-1', { kind: 'note', what: '   ' }), /needs a non-empty "what"/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a task budget refuses runs and remembers what was spent', () => {
  const dir = tempDir('tasks-budget')
  try {
    const store = createTaskStore({ dir })
    store.createMany([{ title: 'x' }], { mode: 'assigned', budget: { maxRuns: 1, maxTokens: 100 } })
    assert.equal(store.budgetState('task-1').ok, true)
    store.recordRun('task-1', { runId: 'codex-1', tokens: 40, threadId: 'thr-1' })
    assert.equal(store.get('task-1').spent.runs, 1)
    assert.equal(store.get('task-1').codexThreadId, 'thr-1')
    const exhausted = store.budgetState('task-1')
    assert.equal(exhausted.ok, false)
    assert.match(exhausted.reason, /reached its Codex run budget \(1\/1\)/)
    store.setBudget('task-1', { maxRuns: 3 })
    assert.equal(store.budgetState('task-1').ok, true)
    store.recordRun('task-1', { runId: 'codex-2', tokens: 500 })
    assert.match(store.budgetState('task-1').reason, /reached its Codex token budget \(540\/100\)/)
    assert.deepEqual(store.summary(), { total: 1, todo: 1, doing: 0, blocked: 0, done: 0, unverified: 0 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('routing names an owner and says why', () => {
  assert.equal(routeTask({ title: 'Bulk rename in src' }, ROUTING_DEFAULTS, 'dsh').owner, 'codex')
  assert.equal(routeTask({ title: 'Debug the flaky test' }, ROUTING_DEFAULTS, 'dsh').owner, 'dsh')
  assert.equal(routeTask({ title: 'Do the thing' }, ROUTING_DEFAULTS, 'dsh').owner, 'dsh')
  assert.equal(routeTask({ title: 'Do the thing' }, ROUTING_DEFAULTS, 'codex').owner, 'codex')
  const explicit = routeTask({ title: 'Bulk rename', owner: 'dsh', why: 'the user said so' }, ROUTING_DEFAULTS, 'codex')
  assert.equal(explicit.owner, 'dsh')
  assert.equal(explicit.assignedBy, 'user')
  assert.match(routeTask({ title: 'Review the patch' }, ROUTING_DEFAULTS, 'dsh').reason, /independent reviewer/)
})

test('each mode cuts the goal into its own shape', () => {
  const pipeline = expandMode({ mode: 'pipeline', goal: 'Ship v2' })
  assert.equal(pipeline.length, 4)
  assert.deepEqual(
    pipeline.map((task) => task.owner),
    ['codex', 'codex', 'codex', 'dsh'],
  )
  assert.deepEqual(
    expandMode({ mode: 'adversarial', goal: 'Ship v2', producer: 'dsh' }).map((task) => task.owner),
    ['dsh', 'codex'],
  )
  assert.equal(expandMode({ mode: 'blind', goal: 'Ship v2' }).length, 3)
  assert.equal(expandMode({ mode: 'assigned', goal: 'Ship v2' }).length, 1)
  assert.equal(expandMode({ mode: 'consult', goal: 'Why is it slow?' })[0].tags[0], 'second-opinion')
})

test('the plan prompt asks for a split critique under a schema', () => {
  const prompt = buildPlanPrompt({
    goal: 'Ship v2',
    mode: 'self-organizing',
    drafts: [{ title: 'Do it', owner: 'codex', acceptance: 'tests pass' }],
    cwd: 'C:\\work',
  })
  assert.ok(prompt.includes('Ship v2'))
  assert.ok(prompt.includes('Do it'))
  assert.ok(prompt.includes('single JSON object'))
  assert.ok(prompt.includes('C:\\work'))
  assert.equal(PLAN_SCHEMA.type, 'object')
  assert.deepEqual(PLAN_SCHEMA.required, ['summary', 'tasks', 'risks'])
  assert.equal(PLAN_SCHEMA.additionalProperties, false)
})

test('the plan and task renderers describe the work in text', () => {
  const task = {
    id: 'task-1',
    title: 'Ship v2',
    owner: 'codex',
    assignedBy: 'routing',
    status: 'doing',
    scope: ['src'],
    tags: [],
    acceptance: 'tests pass',
    blockedBy: [],
    evidence: [],
    budget: { maxRuns: 5, maxTokens: 100 },
    spent: { runs: 1, tokens: 20 },
    codexThreadId: null,
    why: 'bulk edits',
    mode: 'assigned',
    approvedAt: null,
    updatedAt: 'x',
  }
  assert.ok(renderTaskLine(task).startsWith('[~] task-1 · Ship v2'))
  const markdown = renderPlanMarkdown({ goal: 'Ship v2', mode: 'assigned' }, [task], '2026-10-08T00:00:00.000Z')
  assert.ok(markdown.includes('# Codex peer plan'))
  assert.ok(markdown.includes('task-1'))
  assert.ok(markdown.includes('Source of truth'))
  const plan = renderPlanResult({
    status: 'ok',
    goal: 'Ship v2',
    mode: 'assigned',
    tasks: [taskView(task)],
    planFile: 'C:\\p\\PLAN.md',
    notes: ['n'],
    critique: { summary: 'fine', risks: ['scope creep'] },
  })
  assert.ok(plan.includes('codex peer plan · assigned'))
  assert.ok(plan.includes('risk: scope creep'))
  assert.ok(plan.includes('mirror: C:\\p\\PLAN.md'))
  assert.ok(renderTaskResult({ action: 'show', task: taskView(task), notes: [] }).includes('codex task show · task-1'))
  assert.ok(
    renderTaskResult({ action: 'list', summary: { total: 1, todo: 0, doing: 1, blocked: 0, done: 0, unverified: 0 }, tasks: [task] }).includes(
      'codex peer work list · 1 task(s)',
    ),
  )
})

test('codex_plan and codex_task declare their required parameters', () => {
  const dir = tempDir('schemas')
  try {
    const subject = { config: config(), ledger: createLedger({ dir }) }
    const plan = codexPlanTool(subject)
    assert.deepEqual(plan.parameters.required, ['goal'])
    assert.equal(plan.parameters.additionalProperties, false)
    const task = codexTaskTool(subject)
    assert.deepEqual(task.parameters.required, ['action'])
    for (const action of ['list', 'show', 'claim', 'update', 'record-evidence', 'set-budget', 'run']) {
      assert.ok(task.parameters.properties.action.description.includes(action))
    }
    assert.equal(task.parameters.properties.evidence.required[0], 'what')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the plan tool records the split without calling Codex when told not to', async () => {
  const dir = tempDir('plan-tool')
  try {
    const subject = { config: config(), ledger: createLedger({ dir }), tasks: createTaskStore({ dir }) }
    subject.ledger.ensure()
    const tool = codexPlanTool(subject)
    const value = await tool.execute(
      {
        goal: 'Ship v2',
        mode: 'assigned',
        propose: 'none',
        tasks: [
          { title: 'Write docs', owner: 'dsh', acceptance: 'README updated' },
          { title: 'Bulk rename', tags: ['bulk'] },
        ],
      },
      {},
    )
    assert.equal(value.status, 'ok')
    assert.equal(value.tasks.length, 2)
    assert.equal(value.tasks[0].owner, 'dsh')
    assert.equal(value.tasks[1].owner, 'codex')
    assert.equal(value.tasks[1].assignedBy, 'routing')
    assert.equal(typeof value.approvedAt, 'string')
    assert.ok(value.notes.some((note) => note.includes('no Codex critique')))
    assert.equal(subject.tasks.list().length, 2)
    assert.ok(renderPlanResult(value).includes('task-2'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the task tool lists, claims, records evidence and refuses an over-budget run', async () => {
  const dir = tempDir('task-tool')
  try {
    const subject = { config: config(), ledger: createLedger({ dir }), tasks: createTaskStore({ dir }) }
    subject.ledger.ensure()
    subject.tasks.createMany([{ title: 'Ship v2' }], { mode: 'assigned', budget: { maxRuns: 0, maxTokens: 0 } })
    const tool = codexTaskTool(subject)
    const list = await tool.execute({ action: 'list' }, {})
    assert.equal(list.summary.total, 1)
    assert.equal(list.tasks[0].id, 'task-1')
    const claimed = await tool.execute({ action: 'claim', taskId: 'task-1', owner: 'codex' }, {})
    assert.equal(claimed.task.owner, 'codex')
    const doing = await tool.execute({ action: 'update', taskId: 'task-1', status: 'doing', note: 'started' }, {})
    assert.equal(doing.task.status, 'doing')
    const evidence = await tool.execute(
      { action: 'record-evidence', taskId: 'task-1', evidence: { kind: 'command', what: 'npm test', result: 'pass' }, status: 'done' },
      {},
    )
    assert.equal(evidence.task.status, 'done')
    assert.equal(evidence.task.evidence.length, 1)
    await assert.rejects(tool.execute({ action: 'run', taskId: 'task-1', prompt: 'do it' }, {}), /reached its Codex run budget/)
    await assert.rejects(tool.execute({ action: 'run', taskId: 'task-2', prompt: 'do it' }, {}), /unknown task/)
    await assert.rejects(tool.execute({ action: 'fly' }, {}), /unknown action/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the plan call is always asked for, and an approved task is not asked again', () => {
  const dir = tempDir('gate-plan')
  try {
    const subject = { config: config(), ledger: createLedger({ dir }), tasks: createTaskStore({ dir }) }
    subject.ledger.ensure()
    const gate = createApprovalGate(subject)
    const next = () => ({ kind: 'allow' })
    assert.equal(planNeedsApproval('mutating'), true)
    assert.equal(planNeedsApproval('never'), false)
    const asked = gate({ name: 'codex_plan', arguments: { goal: 'Ship v2' } }, next)
    assert.equal(asked.kind, 'ask')
    assert.match(asked.reason, /shared work plan/)
    subject.tasks.createMany([{ title: 'x' }], { mode: 'assigned', approvedAt: '2026-10-08T00:00:00.000Z' })
    assert.equal(gate({ name: 'codex_ask', arguments: { prompt: 'x', mode: 'implement', taskId: 'task-1' } }, next).kind, 'allow')
    subject.tasks.createMany([{ title: 'y' }], { mode: 'assigned' })
    assert.equal(gate({ name: 'codex_ask', arguments: { prompt: 'x', mode: 'implement', taskId: 'task-2' } }, next).kind, 'ask')
    const perRun = createApprovalGate({ config: config({ approvePerTask: false }), tasks: subject.tasks })
    assert.equal(perRun({ name: 'codex_ask', arguments: { prompt: 'x', mode: 'implement', taskId: 'task-1' } }, next).kind, 'ask')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** Throws unless `value` can be represented as lossless JSON. */
function assertLossless(value, path = 'value', seen = new WeakSet()) {
  if (value === null) return
  if (value === undefined) throw new Error(`${path} is undefined`)
  const type = typeof value
  if (type === 'string' || type === 'boolean') return
  if (type === 'number') {
    assert.ok(Number.isFinite(value), `${path} is ${value}`)
    return
  }
  if (type !== 'object') throw new Error(`${path} is a ${type}`)
  if (value instanceof Date) throw new Error(`${path} is a Date`)
  if (seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertLossless(item, `${path}[${index}]`, seen))
    return
  }
  for (const [key, child] of Object.entries(value)) assertLossless(child, `${path}.${key}`, seen)
}

test('toJsonValue turns a messy value into lossless JSON', () => {
  const dirty = {
    a: undefined,
    b: Number.NaN,
    c: Number.POSITIVE_INFINITY,
    d: [1, undefined, 2],
    e: new Date('2026-10-08T00:00:00.000Z'),
    f: () => {},
    g: { h: undefined, i: 'x' },
    big: 12n,
  }
  dirty.self = dirty
  const clean = toJsonValue(dirty)
  assert.deepEqual(clean, { b: null, c: null, d: [1, null, 2], e: '2026-10-08T00:00:00.000Z', g: { i: 'x' }, big: '12', self: null })
  assert.equal(Object.hasOwn(clean, 'a'), false)
  assert.equal(Object.hasOwn(clean, 'f'), false)
  assertLossless(clean)
})

test('every registered tool answers with lossless JSON', async () => {
  const dir = tempDir('lossless')
  try {
    const executable = join(dir, 'codex.exe')
    writeFileSync(executable, '')
    const subject = { config: config({ codexPath: executable }), ledger: createLedger({ dir }), tasks: createTaskStore({ dir }) }
    subject.ledger.ensure()
    const registered = []
    const ctx = { tools: { register: (tool) => { registered.push(tool); return () => {} } } }
    registerTools(ctx, subject)
    assert.equal(registered.length, 5)
    // codex_status is the call the live harness rejected: no version probe ran,
    // so those fields exist but are empty, and the wrapper must drop them.
    const status = registered.find((tool) => tool.name === 'codex_status')
    assertLossless(await status.execute({ limit: 3, cwd: 'C:\\work' }, { agent: { session: { header: { cwd: 'C:\\work' } } } }))
    const task = registered.find((tool) => tool.name === 'codex_task')
    assertLossless(await task.execute({ action: 'list' }, {}))
    assertLossless(task.presentCall({ action: 'list' }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
