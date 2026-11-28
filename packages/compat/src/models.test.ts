import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type ModelRunDeps, runModels } from './models.js'
import type { ModelReport } from './run.js'
import { fakeWorld, scriptedModel } from './test/fake-world.js'

/** A run whose businesses are folders made for the test, holding a stand-in for the keys. */
function deps(failOpen: (dir: string) => boolean) {
  const dirs: string[] = []
  const saved: string[][] = []
  const closed: string[] = []
  const d: ModelRunDeps = {
    trials: 1,
    prepare: async () => {
      const dir = mkdtempSync(join(tmpdir(), 'avow-compat-test-'))
      writeFileSync(join(dir, 'keys'), 'made for this test')
      dirs.push(dir)
      return dir
    },
    open: async (dir) => {
      if (failOpen(dir)) throw new Error('The MCP server stopped before it answered')
      const world = fakeWorld()
      return { ...world, close: async () => void closed.push(dir) }
    },
    model: (id) => ({ ...scriptedModel(), id }),
    system: (instructions) => instructions,
    save: (reports: readonly ModelReport[]) =>
      saved.push(reports.map((r) => `${r.model} ${r.error ?? 'ran'}`)),
    progress: () => {},
  }
  return { d, dirs, saved, closed }
}

describe('a run of several models', () => {
  it("makes a failed model's run its error row, runs the next and saves after each", async () => {
    const { d, dirs, saved, closed } = deps((dir) => dir === dirs[0])
    const reports = await runModels(['first/model', 'second/model'], d)
    expect(reports.map((r) => [r.model, r.error, r.scenarios.length])).toEqual([
      ['first/model', 'The MCP server stopped before it answered', 0],
      ['second/model', null, 7],
    ])
    expect(saved).toEqual([
      ['first/model The MCP server stopped before it answered'],
      ['first/model The MCP server stopped before it answered', 'second/model ran'],
    ])
    expect(closed).toEqual([dirs[1]])
  })

  it("deletes each test business's folder, with its keys, whether its run failed or finished", async () => {
    const { d, dirs } = deps((dir) => dir === dirs[0])
    await runModels(['first/model', 'second/model'], d)
    expect(dirs).toHaveLength(2)
    for (const dir of dirs) expect(existsSync(dir)).toBe(false)
  })
})
