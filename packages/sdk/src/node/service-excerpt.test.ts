import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { serviceExcerpt } from './service-excerpt.js'

const starter = readFileSync(
  new URL('../../../../examples/starter/template/service.ts', import.meta.url),
  'utf8',
)

describe("a service file's deciding lines", () => {
  it("picks the starter's budget, switch and check, numbered as the file numbers them", () => {
    const excerpt = serviceExcerpt(starter)
    expect(excerpt?.budget).toBe(3)
    const lines = excerpt?.lines ?? []
    expect(lines.map((l) => l.text.trim())).toEqual([
      'computeBudgetPerGpuHour: 3,',
      'bookCompute: true,',
      'async checkBeforeWork(job, avow) {',
      'const check = await avow.verifyCommitment(job)',
      'return check.ok ? start(check) : dontStart(check)',
      '},',
    ])
    const numbers = starter.split('\n')
    for (const l of lines) expect(numbers[l.line - 1]?.trimEnd()).toBe(l.text)
  })

  it('reads an edited budget, and has none for a budget that is not a plain number', () => {
    expect(serviceExcerpt(starter.replace('PerGpuHour: 3,', 'PerGpuHour: 2.5,'))?.budget).toBe(2.5)
    const computed = starter.replace('PerGpuHour: 3,', 'PerGpuHour: limits.budget,')
    expect(serviceExcerpt(computed)?.budget).toBeNull()
  })

  it('gives nothing for a file reshaped past the starter, rather than guessing', () => {
    expect(serviceExcerpt('export default somethingElse()')).toBeNull()
    const unclosed = starter.replace(/\n {2}\},\n\}\)/, '\n')
    expect(serviceExcerpt(unclosed)).toBeNull()
  })
})
