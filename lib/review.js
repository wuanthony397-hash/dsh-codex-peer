/**
 * The structured review contract.
 *
 * `codex_review` is the "Codex produces, Harness consumes" half of the peer
 * relationship, so its answer must be machine-readable rather than prose. The
 * schema below is written as Codex's `--output-schema` file: the CLI constrains
 * its final message to this shape, and {@link normalizeReview} turns whatever
 * comes back into findings the Harness can act on without trusting it blindly.
 *
 * @module dsh-codex-peer/review
 */

/**
 * The JSON Schema handed to `codex exec --output-schema`.
 *
 * Every property is required and `additionalProperties` is closed, which is
 * what structured-output modes expect; unknown values are expressed as null
 * rather than omitted.
 */
export const REVIEW_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'CodexPeerReview',
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'findings'],
  properties: {
    verdict: {
      type: 'string',
      enum: ['pass', 'concerns', 'fail'],
      description: 'pass: nothing worth changing. concerns: real issues, none blocking. fail: at least one blocker.',
    },
    summary: {
      type: 'string',
      description: 'Two to five sentences a reader could act on without reading the findings.',
    },
    findings: {
      type: 'array',
      description: 'Every issue worth reporting, most severe first. Empty when the verdict is pass.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'title', 'file', 'line', 'detail', 'suggestion'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
          title: { type: 'string', description: 'One line naming the defect, not the fix.' },
          file: { type: ['string', 'null'], description: 'Repository-relative path, or null when the finding is not file-specific.' },
          line: { type: ['integer', 'null'], description: 'Line number in that file, or null.' },
          detail: { type: 'string', description: 'What is wrong and why it matters, with the evidence you read.' },
          suggestion: { type: ['string', 'null'], description: 'The smallest change that resolves it, or null when you have no concrete suggestion.' },
        },
      },
    },
  },
})

/** How a review target is turned into instructions. */
export const REVIEW_TARGETS = Object.freeze({
  'working-tree': 'the uncommitted changes in this working tree (`git status --short`, then `git diff HEAD` — include untracked files by reading them)',
  staged: 'the staged changes (`git diff --cached`)',
  'last-commit': 'the most recent commit (`git show HEAD`)',
})

/**
 * Build the review prompt.
 * @param options - `target`, `focus`, `cwd`.
 * @returns the prompt text for Codex's stdin.
 */
export function buildReviewPrompt(options) {
  const target = typeof options.target === 'string' && options.target.trim() !== '' ? options.target.trim() : 'working-tree'
  const described = REVIEW_TARGETS[target] ?? `the following, read directly from the working tree: ${target}`
  const lines = [
    'Mode: review.',
    `Review ${described}.`,
    'Read the changed files and enough surrounding code to judge them; do not judge a diff in isolation when the surrounding code decides whether it is correct.',
    'You are the reviewer, not the author: do not modify any file, and do not restate the diff back to the reader.',
    'Report only defects you can point at, each with the evidence you read. A blocker is something that is wrong or will break; a nit is style or polish. If you find nothing, say so with an empty findings array rather than inventing work.',
    'Your final message must be a single JSON object matching the provided schema — no prose around it.',
  ]
  const focus = typeof options.focus === 'string' ? options.focus.trim() : ''
  if (focus !== '') lines.push(`Reviewer focus from the Harness agent (weight it heavily, but still report anything severe you find outside it): ${focus}`)
  lines.push(`Working directory: ${options.cwd}`)
  return `${lines.join('\n')}\n`
}

/**
 * Parse a model answer that should be JSON, tolerating a fenced block or
 * surrounding prose.
 * @param text - the raw final message.
 * @returns the parsed value, or undefined when no JSON object was found.
 */
export function parseLooseJson(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return undefined
  try {
    return JSON.parse(raw)
  } catch {
    // fall through to recovery
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  if (fenced !== null) {
    try {
      return JSON.parse(fenced[1].trim())
    } catch {
      // fall through to brace scanning
    }
  }
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1))
    } catch {
      return undefined
    }
  }
  return undefined
}

const SEVERITIES = ['blocker', 'major', 'minor', 'nit']
const VERDICTS = ['pass', 'concerns', 'fail']

/**
 * Turn a Codex answer into a review result the Harness can rely on.
 *
 * Normalization is deliberately forgiving about shape and strict about labels:
 * an unknown severity becomes `major` and an unknown verdict is derived from
 * the findings, so a slightly-off answer still ranks correctly instead of
 * silently reading as a pass.
 *
 * @param value - the parsed answer, when it was JSON.
 * @param raw - the raw answer text (kept as the fallback summary).
 * @returns `{ verdict, summary, findings, structured, notes }`.
 */
export function normalizeReview(value, raw) {
  const notes = []
  const text = String(raw ?? '')
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    if (text.trim() !== '') notes.push('the answer was not the structured review object; it is carried as raw text')
    return { verdict: 'concerns', summary: text.trim(), findings: [], structured: false, notes }
  }
  const findings = []
  for (const candidate of Array.isArray(value.findings) ? value.findings : []) {
    if (candidate === null || typeof candidate !== 'object') continue
    const severity = SEVERITIES.includes(candidate.severity) ? candidate.severity : 'major'
    if (!SEVERITIES.includes(candidate.severity) && candidate.severity !== undefined) notes.push(`unknown severity "${String(candidate.severity)}" reported as major`)
    const title = typeof candidate.title === 'string' && candidate.title.trim() !== '' ? candidate.title.trim() : 'untitled finding'
    const line = typeof candidate.line === 'number' && Number.isFinite(candidate.line) ? candidate.line : null
    findings.push({
      severity,
      title,
      file: typeof candidate.file === 'string' && candidate.file.trim() !== '' ? candidate.file.trim() : null,
      line,
      detail: typeof candidate.detail === 'string' ? candidate.detail.trim() : '',
      suggestion: typeof candidate.suggestion === 'string' && candidate.suggestion.trim() !== '' ? candidate.suggestion.trim() : null,
    })
  }
  const rank = { blocker: 0, major: 1, minor: 2, nit: 3 }
  findings.sort((left, right) => rank[left.severity] - rank[right.severity])
  let verdict = VERDICTS.includes(value.verdict) ? value.verdict : undefined
  if (verdict === undefined) {
    verdict = findings.some((finding) => finding.severity === 'blocker') ? 'fail' : findings.length > 0 ? 'concerns' : 'pass'
    notes.push('the answer carried no usable verdict; it was derived from the findings')
  }
  const summary = typeof value.summary === 'string' && value.summary.trim() !== '' ? value.summary.trim() : findings.length === 0 ? '(no summary provided)' : `${findings.length} finding(s)`
  return { verdict, summary, findings, structured: true, notes }
}

/**
 * Count findings by severity.
 * @param findings - normalized findings.
 * @returns `{ blocker, major, minor, nit, total }`.
 */
export function countFindings(findings) {
  const counts = { blocker: 0, major: 0, minor: 0, nit: 0, total: findings.length }
  for (const finding of findings) counts[finding.severity] += 1
  return counts
}
