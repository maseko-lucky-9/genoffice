import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Guards the fork against the upstream Genspark sign-in and cloud code
 * creeping back in through a merge: no source, build or tooling file may reach
 * the Genspark service, its CLI, its key or its IPC channels.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const FORBIDDEN = /genspark\.ai|@genspark\/cli|gskApiKey|GSK_[A-Z]|ai:gsk-|genoffice-auth/

/**
 * Exact files only, each with the one line shape it may contain:
 * - the redaction XML namespace is a document-format identifier, not a service;
 * - the deb maintainer/vendor fields keep the published package lineage for apt
 *   (Linux packaging metadata is deliberately left as upstream shipped it).
 */
const ALLOWLIST = new Map([
  ['packages/agent-core/src/redact-range.ts', 'export const REDACT_NS ='],
  ['apps/shell/electron-builder.cjs', "'Mainfunc, Inc. <team@genspark.ai>',"],
])

/** single files scanned outside the src trees: the packaging config that ships the app */
const EXTRA_FILES = ['apps/shell/electron-builder.cjs']

const toRel = (path: string): string => relative(REPO_ROOT, path).split(sep).join('/')

function scanRoots(): string[] {
  const roots: string[] = [join(REPO_ROOT, 'tools')]
  for (const group of ['apps', 'packages']) {
    for (const name of readdirSync(join(REPO_ROOT, group))) {
      const src = join(REPO_ROOT, group, name, 'src')
      try {
        if (statSync(src).isDirectory()) roots.push(src)
      } catch {
        // a workspace without a src directory has nothing to scan
      }
    }
  }
  return roots
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, out)
    else if (entry.isFile()) out.push(path)
  }
}

describe('no Genspark service code', () => {
  it('finds the roots it scans', () => {
    const roots = scanRoots().map(toRel)
    expect(roots).toContain('packages/ai-provider/src')
    expect(roots).toContain('apps/shell/src')
    expect(roots).toContain('tools')
  })

  it('keeps every Genspark endpoint, CLI, key and IPC channel out of src, tools and the builder config', () => {
    const files: string[] = EXTRA_FILES.map((rel) => join(REPO_ROOT, rel))
    for (const root of scanRoots()) walk(root, files)
    const hits: string[] = []
    for (const file of files) {
      const rel = toRel(file)
      const allowed = ALLOWLIST.get(rel)
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!FORBIDDEN.test(line)) return
        if (allowed !== undefined && line.includes(allowed)) return
        hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`)
      })
    }
    expect(hits).toEqual([])
  })

  it('allowlists exactly the two known files, each still holding its excused line', () => {
    expect([...ALLOWLIST.keys()].sort()).toEqual([
      'apps/shell/electron-builder.cjs',
      'packages/agent-core/src/redact-range.ts',
    ])
    for (const [rel, allowed] of ALLOWLIST) {
      const matching = readFileSync(join(REPO_ROOT, rel), 'utf8')
        .split('\n')
        .filter((line) => FORBIDDEN.test(line))
      // a stale entry excuses nothing and must go
      expect(matching.length).toBeGreaterThan(0)
      for (const line of matching) expect(line).toContain(allowed)
    }
  })
})
