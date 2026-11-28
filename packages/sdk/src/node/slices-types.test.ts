import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'slices-nodenext')
const TSC = join(
  dirname(createRequire(import.meta.url).resolve('typescript/package.json')),
  'bin',
  'tsc',
)

describe('the slices entry as Node resolves it', () => {
  it("gives a NodeNext consumer the socket calls' types from the package's built output", () => {
    // The fixture sits inside the package, so it imports the package by its own name, through
    // the exports map a published install reads.
    const run = () =>
      execFileSync(process.execPath, [TSC, '-p', join(FIXTURE, 'tsconfig.json')], {
        encoding: 'utf8',
      })
    expect(run).not.toThrow()
  }, 60_000)
})
