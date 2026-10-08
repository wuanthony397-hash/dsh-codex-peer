/**
 * The tools that manage the shared work list: `codex_plan` and `codex_task`.
 *
 * Keeping them in their own module keeps `tools.js` about talking to Codex and
 * this file about deciding who does what. The split is deliberate: a run is one
 * thing, a work list is another, and `codex_task action:run` is the one place
 * where they meet — a run that is budgeted, recorded, and leaves evidence.
 *
 * @module dsh-codex-peer/planning-tools
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runPeerRequest } from './execute.js'
import { MODE_NOTES, PLAN_MODES, PLAN_SCHEMA, buildPlanPrompt, expandMode, renderPlanMarkdown, renderTaskLine, routeTask } from './plan.js'
import { EVIDENCE_KINDS, TASK_STATUSES } from './tasks.js'
import { describeOutcome } from './runner.js'
import { parseLooseJson } from './review.js'

/** @returns the compact, model-facing view of one task. */
export function taskView(task) {
  return {
    id: task.id,
    title: task.title,
    owner: task.owner,
    assignedBy: task.assignedBy,
    why: task.why,
    status: task.status,
    mode: task.mode,
    scope: task.scope,
    tags: task.tags,
    acceptance: task.acceptance,
    blockedBy: task.blockedBy,
    evidence: task.evidence,
    budget: task.budget,
    spent: task.spent,
    codexThreadId: task.codexThreadId,
    approvedAt: task.approvedAt,
    updatedAt: task.updatedAt,
  }
}

/** @returns the rendered text of a plan result. */
export function renderPlanResult(value) {
  const lines = [
    `codex peer plan · ${value.mode} · ${MODE_NOTES[value.mode] ?? value.mode} · ${value.tasks.length} task(s)`,
    `goal: ${value.goal}`,
  ]
  if (value.planFile !== undefined) lines.push(`mirror: ${value.planFile}`)
  if (value.critique !== undefined) {
    lines.push(
      `codex critique: ${value.critique.summary}`,
      ...(value.critique.risks.length === 0 ? [] : value.critique.risks.map((risk) => `  risk: ${risk}`)),
    )
  }
  lines.push('', 'tasks:')
  for (const task of value.tasks) lines.push(`- ${task.id} · ${task.title} — owner ${task.owner} (${task.assignedBy})${task.scope.length === 0 ? '' : ` · scope ${task.scope.join(', ')}`}`)
  for (const note of value.notes) lines.push(`note: ${note}`)
  lines.push('', 'Work the tasks you own; hand the others over with codex_task action:run, and record evidence before marking anything done.')
  return lines.join('\n')
}

/** @returns the rendered text of a task result. */
export function renderTaskResult(value) {
  if (value.action === 'list') {
    const lines = [
      `codex peer work list · ${value.summary.total} task(s) (${value.summary.todo} todo, ${value.summary.doing} doing, ${value.summary.blocked} blocked, ${value.summary.done} done, ${value.summary.unverified} unverified)`,
    ]
    if (value.tasks.length === 0) lines.push('', '(empty)')
    for (const task of value.tasks) lines.push(`- ${renderTaskLine(task)}`)
    return lines.join('\n')
  }
  const lines = [`codex task ${value.action} · ${value.task.id} · ${value.task.status}`, renderTaskLine(value.task)]
  for (const note of value.notes) lines.push(`note: ${note}`)
  return lines.join('\n')
}

/** @returns the running/promoted rendering shared by task-scoped runs. */
function runningText(value) {
  return [
    `[codex ${value.mode} is still running for task ${value.taskId}; background job ${value.jobId}]`,
    `recent progress:\n${value.progressTail}`,
    `Read more with job_output (job_id ${value.jobId}); the run is charged to the task when it settles.`,
  ].join('\n\n')
}

/** @returns the JSON value of one task-scoped run. */
function runValue(taskId, result) {
  if (result.kind !== 'run') {
    return {
      status: 'running',
      action: 'run',
      taskId,
      jobId: result.jobId,
      mode: result.plan.mode,
      runId: result.plan.runId,
      progressTail: result.progress.text().trimEnd().split('\n').slice(-10).join('\n'),
    }
  }
  const outcome = result.outcome
  return {
    status: outcome.status,
    action: 'run',
    taskId,
    runId: outcome.runId,
    runDir: outcome.runDir,
    mode: outcome.mode,
    sandbox: outcome.sandbox,
    threadId: outcome.threadId,
    usage: outcome.usage,
    durationMs: outcome.durationMs,
    exitCode: outcome.exitCode,
    answer: outcome.answer,
    commands: outcome.commands,
    fileChanges: outcome.fileChanges,
    errors: outcome.errors,
    notes: outcome.notes,
  }
}

/** The parameter schema both planning tools share for a run. */
function runProperties() {
  return {
    prompt: { type: 'string', description: 'The request for this run, written as a self-contained hand-off.' },
    mode: { type: 'string', description: 'ask | plan | implement (default implement for a task run)' },
    sandbox: { type: 'string', description: 'read-only | workspace-write | danger-full-access' },
    background: { type: 'boolean', description: 'Return a background job handle instead of waiting.' },
  }
}

/**
 * `codex_plan` — record who does what.
 * @param peer - the runtime peer object.
 * @returns the tool definition.
 */
export function codexPlanTool(peer) {
  return {
    name: 'codex_plan',
    description:
      'Agree and record the split of a goal between this agent (dsh) and the local Codex peer, as a shared work list both sides read. Use it when a task is big enough to divide: pass the tasks you already decided (tasks) for a user-directed split, or pass only the goal to have the split made for you (mode decides how, and the routing table explains each choice). With mode "self-organizing" this agent drafts the split and Codex critiques it before it is recorded. Approving this call approves the plan: with approvePerTask (default) the Codex runs inside those tasks no longer ask one by one. Each task carries its owner, what may be touched, what counts as done, and a per-task Codex budget.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['goal'],
      properties: {
        goal: { type: 'string', description: 'What the two agents must achieve, in one or two sentences.' },
        tasks: {
          type: 'array',
          description: 'The split, when it is already decided. Omit to let the mode produce it.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['title'],
            properties: {
              title: { type: 'string' },
              owner: { type: 'string', description: 'dsh | codex | shared | unassigned (default: routing decides)' },
              acceptance: { type: 'string', description: 'What must be true for this task to count as done, in checkable terms.' },
              scope: { type: 'array', items: { type: 'string' }, description: 'Files or directories this task may touch.' },
              tags: { type: 'array', items: { type: 'string' }, description: 'Words the routing table matches, such as bulk, review, debug.' },
              why: { type: 'string', description: 'Why this owner, when the user named it.' },
            },
          },
        },
        mode: { type: 'string', description: `${PLAN_MODES.join(' | ')} (default assigned)` },
        propose: {
          type: 'string',
          description: 'dsh (default): this agent drafts, Codex critiques. codex: Codex drafts first. none: record the split as-is without calling Codex.',
        },
        producer: { type: 'string', description: 'adversarial only: which side produces the first version (dsh default, so Codex attacks it).' },
        budget: {
          type: 'object',
          additionalProperties: true,
          properties: {
            maxRuns: { type: 'number', description: 'Codex runs this task may spend.' },
            maxTokens: { type: 'number', description: 'Codex tokens this task may spend.' },
          },
        },
        replace: { type: 'boolean', description: 'Replace the whole work list instead of adding to it.' },
        mirror: { type: 'boolean', description: 'Also write the configured planFile mirror (default true when planFile is set).' },
        cwd: { type: 'string', description: 'Working directory the plan is for. Defaults to the session working directory.' },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: renderPlanResult(value) }] },
    presentCall(args) {
      return { card: 'generic', title: `codex_plan · ${String(args.mode ?? 'assigned')}`, kind: 'other', rawInput: args }
    },
    async execute(args, exec) {
      const config = peer.config
      const notes = []
      const cwd = String(args.cwd ?? exec?.agent?.session?.header?.cwd ?? process.cwd())
      const mode = PLAN_MODES.includes(args.mode) ? args.mode : 'assigned'
      const propose = ['dsh', 'codex', 'none'].includes(args.propose) ? args.propose : (mode === 'self-organizing' ? 'dsh' : 'none')

      const drafts = Array.isArray(args.tasks) && args.tasks.length > 0
        ? args.tasks.map((task) => ({ ...task, assignedBy: task.owner === undefined || task.owner === '' ? undefined : 'user' }))
        : expandMode({ mode, goal: String(args.goal), producer: args.producer })
      if (Array.isArray(args.tasks) && args.tasks.length > 0 && mode !== 'assigned') {
        notes.push(`the ${args.tasks.length} task(s) you listed were used as given; mode "${mode}" would have produced its own split`)
      }

      // Routing fills in whoever is still unassigned, and says why.
      let planned = drafts.map((draft) => {
        const decision = routeTask(draft, config.routingRules, config.defaultOwner)
        return {
          ...draft,
          owner: draft.owner === undefined || draft.owner === '' || draft.owner === 'unassigned' ? decision.owner : draft.owner,
          why: draft.why ?? decision.reason,
          assignedBy: draft.assignedBy ?? decision.assignedBy,
        }
      })

      let critique
      if (propose === 'none') {
        notes.push('no Codex critique was requested (propose: none)')
      } else {
        const prompt = buildPlanPrompt({ goal: String(args.goal), mode, drafts: planned, cwd })
        const result = await runPeerRequest(
          peer,
          {
            prompt,
            mode: 'ask',
            sandbox: 'read-only',
            cwd,
            outputSchemaText: JSON.stringify(PLAN_SCHEMA, null, 2),
            label: `plan critique · ${String(args.goal).slice(0, 60)}`,
          },
          exec,
        )
        if (result.kind === 'run') {
          const parsed = parseLooseJson(result.outcome.answer)
          if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.tasks)) {
            const refined = parsed.tasks
              .filter((task) => task !== null && typeof task === 'object' && typeof task.title === 'string')
              .map((task, index) => ({
                title: task.title,
                owner: ['dsh', 'codex', 'shared'].includes(task.owner) ? task.owner : planned[index]?.owner ?? 'unassigned',
                why: typeof task.why === 'string' ? task.why : planned[index]?.why,
                acceptance: typeof task.acceptance === 'string' ? task.acceptance : planned[index]?.acceptance ?? '',
                scope: Array.isArray(task.scope) ? task.scope.map(String) : planned[index]?.scope ?? [],
                tags: planned[index]?.tags ?? [],
                assignedBy: 'agent',
              }))
            if (refined.length > 0) {
              planned = refined
              notes.push(`Codex refined the split (${refined.length} task(s) after its critique)`)
            }
            critique = {
              summary: typeof parsed.summary === 'string' ? parsed.summary : '',
              risks: Array.isArray(parsed.risks) ? parsed.risks.map(String) : [],
              runId: result.outcome.runId,
              threadId: result.outcome.threadId,
              tokens: result.outcome.usage === null ? null : result.outcome.usage.totalTokens,
            }
          } else {
            notes.push('Codex answered outside the plan schema; the split as drafted was recorded')
          }
        } else {
          notes.push(`the plan critique is still running as job ${result.jobId}; the split as drafted was recorded and can be revised later`)
        }
      }

      const defaults = {
        mode,
        assignedBy: Array.isArray(args.tasks) && args.tasks.length > 0 ? 'user' : 'agent',
        approvedAt: new Date().toISOString(),
        budget: {
          maxRuns: Number.isFinite(args.budget?.maxRuns) ? Math.trunc(args.budget.maxRuns) : config.maxCodexRunsPerTask,
          maxTokens: Number.isFinite(args.budget?.maxTokens) ? Math.trunc(args.budget.maxTokens) : config.maxCodexTokensPerTask,
        },
      }
      const created = args.replace === true ? peer.tasks.replaceAll(planned, defaults) : peer.tasks.createMany(planned, defaults)

      let planFile
      if (config.planFile !== '' && args.mirror !== false) {
        try {
          planFile = join(cwd, config.planFile)
          mkdirSync(dirname(planFile), { recursive: true })
          writeFileSync(planFile, renderPlanMarkdown({ goal: String(args.goal), mode, summary: critique?.summary, risks: critique?.risks }, peer.tasks.list(), defaults.approvedAt), 'utf8')
        } catch (error) {
          planFile = undefined
          notes.push(`the planFile mirror could not be written: ${error?.message ?? String(error)}`)
        }
      }

      return {
        status: 'ok',
        goal: String(args.goal),
        mode,
        propose,
        approvedAt: defaults.approvedAt,
        tasks: created.map(taskView),
        critique,
        planFile,
        notes,
      }
    },
  }
}

/**
 * `codex_task` — read and move the work list, and run a task's Codex side.
 * @param peer - the runtime peer object.
 * @returns the tool definition.
 */
export function codexTaskTool(peer) {
  return {
    name: 'codex_task',
    description:
      'Work the shared work list: list or show tasks; claim one; change its status; record the evidence that proves it; raise its Codex budget; or run its Codex side. A task cannot be marked done without evidence — record what proves it (the command and its result, the artifact, the review), or mark it unverified and say what is missing. action:run is a normal peer run attached to the task: it is refused when the task is out of Codex budget, it is charged against the task, it continues the task’s Codex thread, and its outcome is recorded as evidence.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          description: 'list | show | claim | update | record-evidence | set-budget | run',
        },
        taskId: { type: 'string', description: 'The task to act on (required by everything except list).' },
        status: { type: 'string', description: `${TASK_STATUSES.join(' | ')}` },
        owner: { type: 'string', description: 'dsh | codex | shared | unassigned' },
        note: { type: 'string', description: 'Why the status changed; required when marking something unverified.' },
        acceptance: { type: 'string', description: 'Replacement acceptance line.' },
        scope: { type: 'array', items: { type: 'string' }, description: 'Replacement scope.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Replacement tags.' },
        blockedBy: { type: 'array', items: { type: 'string' }, description: 'Task ids this one waits on.' },
        evidence: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', description: `${EVIDENCE_KINDS.join(' | ')}` },
            what: { type: 'string', description: 'The command that ran, the artifact that exists, or the review that was done.' },
            result: { type: 'string', description: 'What it reported.' },
            by: { type: 'string', description: 'dsh | codex | shared | user' },
            runId: { type: 'string', description: 'The codex-peer run this evidence comes from, when there is one.' },
          },
          required: ['what'],
        },
        budget: {
          type: 'object',
          additionalProperties: true,
          properties: {
            maxRuns: { type: 'number' },
            maxTokens: { type: 'number' },
          },
        },
        limit: { type: 'number', description: 'For action:list, how many tasks to return (default 50).' },
        ...runProperties(),
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: renderTaskResult(value) }] },
    presentCall(args) {
      return { card: 'generic', title: `codex_task · ${String(args.action ?? '')}`, kind: 'other', rawInput: args }
    },
    async execute(args, exec) {
      const notes = []
      if (args.action === 'list') {
        const tasks = peer.tasks.list(args.status === undefined ? {} : { status: args.status })
        const limit = Math.min(200, Math.max(1, Math.trunc(typeof args.limit === 'number' ? args.limit : 50)))
        return { status: 'ok', action: 'list', summary: peer.tasks.summary(), tasks: tasks.slice(0, limit).map(taskView), notes }
      }

      // The action is validated before the id, so a typo is reported as a typo
      // instead of as a missing taskId.
      const taskActions = ['show', 'claim', 'update', 'record-evidence', 'set-budget', 'run']
      if (!taskActions.includes(args.action)) {
        throw new Error(`unknown action "${args.action}"; use list, ${taskActions.join(', ')}`)
      }
      const taskId = typeof args.taskId === 'string' && args.taskId !== '' ? args.taskId : undefined
      if (taskId === undefined) throw new Error(`codex_task action:${args.action} needs a taskId; call codex_task action:list to see them`)

      if (args.action === 'show') {
        const task = peer.tasks.get(taskId)
        if (task === undefined) throw new Error(`unknown task "${taskId}"; call codex_task action:list to see the ids`)
        return { status: 'ok', action: 'show', task: taskView(task), summary: peer.tasks.summary(), notes }
      }

      if (args.action === 'claim') {
        return { status: 'ok', action: 'claim', task: taskView(peer.tasks.update(taskId, { owner: args.owner ?? 'dsh', note: args.note })), notes }
      }

      if (args.action === 'update') {
        const updated = peer.tasks.update(taskId, {
          status: args.status,
          owner: args.owner,
          acceptance: args.acceptance,
          scope: args.scope,
          tags: args.tags,
          blockedBy: args.blockedBy,
          note: args.note,
        })
        return { status: 'ok', action: 'update', task: taskView(updated), summary: peer.tasks.summary(), notes }
      }

      if (args.action === 'record-evidence') {
        const updated = peer.tasks.recordEvidence(taskId, args.evidence ?? {}, { status: args.status })
        return { status: 'ok', action: 'record-evidence', task: taskView(updated), summary: peer.tasks.summary(), notes }
      }

      if (args.action === 'set-budget') {
        const updated = peer.tasks.setBudget(taskId, args.budget ?? {})
        return { status: 'ok', action: 'set-budget', task: taskView(updated), notes }
      }

      if (args.action === 'run') {
        const task = peer.tasks.get(taskId)
        if (task === undefined) throw new Error(`unknown task "${taskId}"; call codex_task action:list to see the ids`)
        const prompt = typeof args.prompt === 'string' && args.prompt.trim() !== '' ? args.prompt : `${task.title}\n\nAcceptance: ${task.acceptance === '' ? '(not stated)' : task.acceptance}`
        if (task.status === 'todo') peer.tasks.update(taskId, { status: 'doing', note: 'a Codex run started for this task' })
        const result = await runPeerRequest(
          peer,
          {
            prompt,
            taskId,
            mode: args.mode ?? 'implement',
            sandbox: args.sandbox,
            background: args.background,
            cwd: args.cwd,
            continueFromLast: task.codexThreadId !== null && task.codexThreadId !== undefined,
            label: `${task.id} · ${task.title}`,
          },
          exec,
        )
        const value = runValue(taskId, result)
        if (result.kind === 'run' && result.outcome.status === 'completed') {
          try {
            peer.tasks.recordEvidence(
              taskId,
              {
                kind: 'artifact',
                what: `codex ${result.outcome.mode} run ${result.outcome.runId}`,
                result: `${describeOutcome(result.outcome)}${result.outcome.answer === '' ? '' : ` — ${result.outcome.answer.trim().split('\n')[0].slice(0, 200)}`}`,
                by: 'codex',
                runId: result.outcome.runId,
              },
            )
            notes.push('the run was recorded as evidence for this task')
          } catch (error) {
            notes.push(`the run could not be recorded as evidence: ${error?.message ?? String(error)}`)
          }
        }
        return { ...value, notes: [...(value.notes ?? []), ...notes] }
      }

      throw new Error(`unknown action "${args.action}"; use list, show, claim, update, record-evidence, set-budget, or run`)
    },
  }
}
