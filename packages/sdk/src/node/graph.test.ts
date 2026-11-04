import { readFileSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist')

/** Every SDK module a module loads, following its relative imports through the build. */
function graph(entry: string): Set<string> {
  const seen = new Set<string>()
  const visit = (file: string) => {
    const path = normalize(file)
    if (seen.has(path)) return
    seen.add(path)
    const text = readFileSync(path, 'utf8')
    for (const [, spec] of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      visit(join(dirname(path), spec as string))
    }
  }
  visit(join(DIST, entry))
  return new Set([...seen].map((p) => relative(DIST, p).split('\\').join('/')))
}

/** The modules that hold the business's key, sign its mandates or change its keys on the account. */
const BUSINESS_SIDE = [
  'sandbox/setup.js',
  'sandbox/business-store.js',
  'sandbox/vault.js',
  'sandbox/keys.js',
  'sandbox/mandate.js',
  'sandbox/business.js',
  'sign.js',
  'node/cli.js',
]

describe("the agent's side of the SDK", () => {
  it('loads none of the modules that hold the business key or change the authority', () => {
    for (const entry of ['agent-entry.js', 'node-agent.js', 'node/mcp.js']) {
      const loaded = graph(entry)
      expect(loaded.has('sandbox/agent.js'), entry).toBe(true)
      expect(
        BUSINESS_SIDE.filter((m) => loaded.has(m)),
        entry,
      ).toEqual([])
    }
  })
})
