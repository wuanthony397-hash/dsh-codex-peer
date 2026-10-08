/**
 * Turning a goal into a split of work, and a split into readable text.
 *
 * Three ideas live here:
 *
 * 1. **Modes are recipes.** A mode says how the split is decided — the user
 *    names it (`assigned`), the routing table decides by strength
 *    (`self-organizing`), or work is cut into stages (`pipeline`,
 *    `adversarial`, `blind`, `consult`). Every recipe produces ordinary work
 *    list entries, so the rest of the plugin needs no special cases.
 * 2. **Routing is a small table, not a black box.** Rules match words in a
 *    task's title, tags, or scope and name the owner plus the reason, so a
 *    split can be explained to the user instead of justified by vibes.
 * 3. **Codex may critique a split.** With `propose: 'codex'` the draft is sent
 *    to Codex in plan mode under a JSON schema; its reply refines titles,
 *    owners, acceptance and scope, and its risks are kept.
 *
 * @module dsh-codex-peer/plan
 */
import { TASK_OWNERS } from './tasks.js'

/** The modes a plan can be built in. */
export const PLAN_MODES = ['assigned', 'self-organizing', 'pipeline', 'adversarial', 'blind', 'consult']

/** What each mode means, in one line each — used by the tools and the docs. */
export const MODE_NOTES = Object.freeze({
  assigned: 'the user named who does what',
  'self-organizing': 'the routing table decided by strength',
  pipeline: 'work was cut into stages: plan, implement, review, fix, verify',
  adversarial: 'one side produces, the other attacks it',
  blind: 'both sides solve it independently, then one compares the results',
  consult: 'no split: a single question, answered by one side',
})

/**
 * The shipped routing table.
 *
 * Rules are matched case-insensitively against a task's title, tags, and scope;
 * the first match wins. The defaults encode the split that actually works: a
 * second agent is good at long, wide, low-interaction work and at reviewing
 * what someone else wrote; this agent is the one holding the user's context,
 * the local environment, and the acceptance decision.
 */
export const ROUTING_DEFAULTS = Object.freeze([
  { when: 'bulk', owner: 'codex', reason: 'wide mechanical edits run best straight through without a human in the loop' },
  { when: 'migrate', owner: 'codex', reason: 'a migration is one repeated edit across many files' },
  { when: 'rename', owner: 'codex', reason: 'a rename is one repeated edit across many files' },
  { when: 'review', owner: 'codex', reason: 'an independent reviewer beats an author reviewing their own work' },
  { when: 'audit', owner: 'codex', reason: 'an independent reviewer beats an author reviewing their own work' },
  { when: 'second-opinion', owner: 'codex', reason: 'a second opinion is only worth having from the other side' },
  { when: 'survey', owner: 'codex', reason: 'reading many files end to end is a long, low-interaction pass' },
  { when: 'summarize', owner: 'codex', reason: 'reading a large body of text is a long, low-interaction pass' },
  { when: 'draft', owner: 'codex', reason: 'a first draft is cheap to produce and easy for the other side to correct' },
  { when: 'debug', owner: 'dsh', reason: 'debugging needs the user available to answer questions mid-run' },
  { when: 'interactive', owner: 'dsh', reason: 'work that must ask the user questions stays here' },
  { when: 'plugin', owner: 'dsh', reason: 'local environment and plugin work depends on this machine\u2019s state' },
  { when: 'install', owner: 'dsh', reason: 'installing changes this machine and needs the user\u2019s approval chain' },
  { when: 'verify', owner: 'dsh', reason: 'accepting evidence is this agent\u2019s job, not the producer\u2019s' },
  { when: 'integration', owner: 'dsh', reason: 'integration needs the whole session context, which lives here' },
  { when: 'decision', owner: 'dsh', reason: 'a decision that needs the user\u2019s judgment belongs with the agent that has it' },
])

/**
 * Pick an owner from the routing table.
 * @param task - `{ title, tags?, scope? }`.
 * @param rules - the routing table (see {@link ROUTING_DEFAULTS}).
 * @param defaultOwner - the owner when nothing matches.
 * @returns `{ owner, reason, assignedBy }`.
 */
export function routeTask(task, rules = ROUTING_DEFAULTS, defaultOwner = 'dsh') {
  if (task.owner !== undefined && task.owner !== 'unassigned' && TASK_OWNERS.includes(task.owner)) {
    return { owner: task.owner, reason: task.why ?? 'named explicitly', assignedBy: task.assignedBy ?? 'user' }
  }
  const haystack = [task.title, ...(task.tags ?? []), ...(task.scope ?? [])].join(' ').toLowerCase()
  for (const rule of rules) {
    if (typeof rule?.when !== 'string' || rule.when === '') continue
    if (haystack.includes(rule.when.toLowerCase())) {
      return { owner: rule.owner, reason: rule.reason ?? `matched "${rule.when}"`, assignedBy: 'routing' }
    }
  }
  return {
    owner: defaultOwner,
    reason: `no routing rule matched, so it stays with the default owner (${defaultOwner})`,
    assignedBy: 'routing',
  }
}

/**
 * Cut a goal into ordinary task drafts for a mode.
 *
 * `assigned` and `self-organizing` produce a single task: the split is about
 * who owns it, not about cutting it up. The staged modes produce several.
 *
 * @param options - `{ mode, goal, producer? }` where `producer` is who writes
 *   the first version in `adversarial` (default `dsh`, so Codex does the attacking).
 * @returns task drafts without owners resolved by routing.
 */
export function expandMode(options) {
  const goal = String(options.goal ?? '').trim()
  const mode = PLAN_MODES.includes(options.mode) ? options.mode : 'assigned'
  const producer = options.producer === 'codex' ? 'codex' : 'dsh'
  const attacker = producer === 'codex' ? 'dsh' : 'codex'
  if (mode === 'pipeline') {
    return [
      { title: `Plan: ${goal}`, tags: ['plan'], owner: 'codex', acceptance: 'an ordered plan naming files, steps, and the checks that prove the result' },
      { title: `Implement: ${goal}`, tags: ['implement'], owner: 'codex', acceptance: 'the change is in the tree and the named checks were run', blockedBy: [] },
      { title: `Review: ${goal}`, tags: ['review'], owner: 'codex', acceptance: 'an independent review of the implementation with evidence for every finding' },
      { title: `Fix and verify: ${goal}`, tags: ['verify'], owner: 'dsh', acceptance: 'review findings addressed or explicitly rejected, checks re-run, evidence recorded' },
    ]
  }
  if (mode === 'adversarial') {
    return [
      { title: `Produce: ${goal}`, tags: ['produce'], owner: producer, acceptance: 'a first version with the evidence that shows it works' },
      { title: `Attack: ${goal}`, tags: ['review', 'second-opinion'], owner: attacker, acceptance: 'the produced result is attacked directly, with reproducible counter-examples' },
    ]
  }
  if (mode === 'blind') {
    return [
      { title: `Independent attempt (dsh): ${goal}`, tags: ['draft'], owner: 'dsh', acceptance: 'a complete answer produced without seeing the other attempt' },
      { title: `Independent attempt (codex): ${goal}`, tags: ['draft'], owner: 'codex', acceptance: 'a complete answer produced without seeing the other attempt' },
      { title: `Compare and pick: ${goal}`, tags: ['decision'], owner: 'dsh', acceptance: 'both attempts compared on stated criteria, with the choice and its reason recorded' },
    ]
  }
  return [{ title: goal, tags: mode === 'consult' ? ['second-opinion'] : [], acceptance: '' }]
}

/** The JSON Schema Codex must answer with when it is asked to critique a split. */
export const PLAN_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'CodexPeerPlanCritique',
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'tasks', 'risks'],
  properties: {
    summary: { type: 'string', description: 'Two to four sentences on whether this split is sound and what you changed.' },
    tasks: {
      type: 'array',
      description: 'The task list as you would have it: every draft task, refined, in the order it should be worked.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'owner', 'why', 'acceptance', 'scope'],
        properties: {
          title: { type: 'string' },
          owner: { type: 'string', enum: ['dsh', 'codex', 'shared'] },
          why: { type: 'string', description: 'Why this owner is the right one for this task.' },
          acceptance: { type: 'string', description: 'What must be true for this task to count as done, in checkable terms.' },
          scope: { type: 'array', items: { type: 'string' }, description: 'Files or directories this task may touch.' },
        },
      },
    },
    risks: { type: 'array', items: { type: 'string' }, description: 'Ways this split could go wrong. Empty when you see none.' },
  },
})

/**
 * The prompt that asks Codex to critique a draft split.
 * @param options - `{ goal, mode, drafts, rules, cwd }`.
 * @returns the prompt text.
 */
export function buildPlanPrompt(options) {
  const lines = [
    'Mode: planning a two-agent split.',
    'Two agents share this working tree: `dsh` (the agent that called you, which holds the user context, the local environment, and the acceptance decision) and `codex` (you, invoked as a peer).',
    `Goal: ${options.goal}`,
    `How the split was decided so far: ${MODE_NOTES[options.mode] ?? options.mode}.`,
    '',
    'Draft split:',
    ...options.drafts.map((draft, index) => {
      const bits = [`${index + 1}. ${draft.title}`, `owner: ${draft.owner ?? 'unassigned'}`]
      if (draft.acceptance) bits.push(`acceptance: ${draft.acceptance}`)
      if (Array.isArray(draft.scope) && draft.scope.length > 0) bits.push(`scope: ${draft.scope.join(', ')}`)
      if (draft.why) bits.push(`why: ${draft.why}`)
      return `- ${bits.join(' | ')}`
    }),
    '',
    'Your job is to make this split better, not to praise it:',
    '- Move a task to the owner who will actually do it better, and say why in one line.',
    '- Split a task that is too big to accept or reject as one unit, and merge tasks that cannot be finished independently.',
    '- Replace a vague acceptance line with something checkable.',
    '- Name the files or directories each task may touch so the two agents do not edit the same file at the same time.',
    '- List the ways this split could fail.',
    'Do not do the work itself and do not modify the working tree; read what you need to judge the split.',
    'Your final message must be a single JSON object matching the provided schema.',
  ]
  if (options.cwd !== undefined) lines.push(`Working directory: ${options.cwd}`)
  return `${lines.join('\n')}\n`
}

/** @returns one task rendered as a single markdown line. */
export function renderTaskLine(task) {
  const marks = { todo: ' ', doing: '~', blocked: '!', done: 'x', unverified: '?' }
  const box = `[${marks[task.status] ?? ' '}]`
  const owner = task.owner === 'unassigned' ? 'unassigned' : task.owner
  const bits = [`${box} ${task.id} · ${task.title}`, `owner: ${owner} (${task.assignedBy})`, `status: ${task.status}`]
  if (task.acceptance !== '') bits.push(`acceptance: ${task.acceptance}`)
  if (task.scope.length > 0) bits.push(`scope: ${task.scope.join(', ')}`)
  bits.push(`evidence: ${task.evidence.length}`)
  if (task.spent.runs > 0) bits.push(`codex runs: ${task.spent.runs}/${task.budget.maxRuns}, tokens: ${task.spent.tokens}/${task.budget.maxTokens}`)
  if (task.why !== undefined && task.why !== '') bits.push(`why: ${task.why}`)
  return bits.join(' | ')
}

/**
 * Render the whole plan as markdown, for the optional repository mirror.
 * @param plan - `{ goal, mode, summary?, risks? }`.
 * @param tasks - the tasks to list.
 * @param at - the timestamp to record.
 * @returns the markdown text.
 */
export function renderPlanMarkdown(plan, tasks, at) {
  const lines = [
    '# Codex peer plan',
    '',
    `- Goal: ${plan.goal}`,
    `- Mode: ${plan.mode} — ${MODE_NOTES[plan.mode] ?? plan.mode}`,
    `- Updated: ${at}`,
    '- Source of truth: the dsh-codex-peer state directory (`tasks.json`); this file is a mirror.',
    '',
    '## Tasks',
    '',
  ]
  for (const task of tasks) lines.push(`- ${renderTaskLine(task)}`)
  if (lines.at(-1) === '') lines.push('(no tasks yet)')
  if (typeof plan.summary === 'string' && plan.summary.trim() !== '') lines.push('', '## Notes', '', plan.summary.trim())
  if (Array.isArray(plan.risks) && plan.risks.length > 0) {
    lines.push('', '## Risks', '')
    for (const risk of plan.risks) lines.push(`- ${risk}`)
  }
  return `${lines.join('\n')}\n`
}
