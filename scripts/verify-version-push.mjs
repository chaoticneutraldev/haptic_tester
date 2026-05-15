#!/usr/bin/env node
/**
 * On branch `main` only: require that `package.json` version `X` has matching git tag `vX` on HEAD.
 * Footer/build use `v${version}` from package.json — this hook aligns that with the tag on the commit.
 *
 * Escape hatch: SKIP_VERSION_CHECK=1 git push …
 */
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

if (process.env.SKIP_VERSION_CHECK === '1') {
  console.warn('verify-version-push: skipped (SKIP_VERSION_CHECK=1)')
  process.exit(0)
}

let branch
try {
  branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim()
} catch {
  process.exit(0)
}

if (branch !== 'main') {
  process.exit(0)
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'))
const version = pkg.version
if (!version || typeof version !== 'string') {
  console.error('verify-version-push: package.json must have a string "version" field')
  process.exit(1)
}

const expectedTag = `v${version}`

let tagsAtHead
try {
  tagsAtHead = execSync('git tag --points-at HEAD', { encoding: 'utf-8' })
    .trim()
    .split('\n')
    .filter(Boolean)
} catch {
  console.error('verify-version-push: could not run git tag --points-at HEAD')
  process.exit(1)
}

if (!tagsAtHead.includes(expectedTag)) {
  console.error(
    `verify-version-push: On "main", HEAD must include git tag "${expectedTag}" matching package.json version "${version}".`,
  )
  console.error(`  Tags on HEAD: ${tagsAtHead.length ? tagsAtHead.join(', ') : '(none)'}`)
  console.error(`  Fix: git tag ${expectedTag}   (then push with tags if needed)`)
  process.exit(1)
}

process.exit(0)
