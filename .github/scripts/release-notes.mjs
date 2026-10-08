#!/usr/bin/env node
/**
 * Write the release notes for one version out of CHANGELOG.md.
 *
 * Usage: node .github/scripts/release-notes.mjs v0.2.1 [outfile]
 *
 * Used by the release workflow, and safe to run by hand when preparing a
 * release from the GitHub UI.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const tag = process.argv[2]
if (tag === undefined || tag === '') {
  console.error('usage: node .github/scripts/release-notes.mjs <tag> [outfile]')
  process.exit(1)
}

const version = tag.replace(/^v/, '')
const outfile = process.argv[3] ?? 'release-notes.md'
const lines = readFileSync('CHANGELOG.md', 'utf8').split(/\r?\n/)
const start = lines.findIndex((line) => line.startsWith(`## [${version}]`))
if (start < 0) {
  console.error(`CHANGELOG.md has no section for ${version}`)
  process.exit(1)
}
const next = lines.findIndex((line, index) => index > start && line.startsWith('## ['))
const notes = lines.slice(start, next < 0 ? lines.length : next).join('\n').trim()
writeFileSync(outfile, `${notes}\n`, 'utf8')
console.log(notes)
