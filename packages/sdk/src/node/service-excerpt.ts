/**
 * The lines of a developer's service file that decided a first run: the compute budget, the
 * compute switch, and `checkBeforeWork`, numbered as the file numbers them. The first run ends on
 * these, so a developer sees the code that held their agent to its rules and where to change it.
 */

export interface ExcerptLine {
  /** The line's number in the file, from 1. */
  line: number
  text: string
}

export interface ServiceExcerpt {
  lines: ExcerptLine[]
  /** The budget the file sets, in dollars per GPU-hour, when it sets one as a plain number. */
  budget: number | null
}

/**
 * The deciding lines of a service file's source, or null when the file doesn't have the shape the
 * starter wrote, since a developer who reshaped it knows where their rules are.
 */
export function serviceExcerpt(source: string): ServiceExcerpt | null {
  const all = source.split('\n')
  const find = (pattern: RegExp) => all.findIndex((text) => pattern.test(text))
  const budgetAt = find(/^\s*computeBudgetPerGpuHour\s*:/)
  const switchAt = find(/^\s*bookCompute\s*:/)
  const checkAt = find(/^\s*(async\s+)?checkBeforeWork\s*\(/)
  if (checkAt === -1) return null
  // The function ends at the first line back at its own indent that closes it.
  const indent = /^\s*/.exec(all[checkAt] ?? '')?.[0] ?? ''
  const endAt = all.findIndex((text, i) => i > checkAt && text.startsWith(`${indent}}`))
  if (endAt === -1 || endAt - checkAt > 20) return null
  const picked = [budgetAt, switchAt].filter((i) => i !== -1)
  for (let i = checkAt; i <= endAt; i++) picked.push(i)
  const budget = budgetAt === -1 ? null : /:\s*(\d+(\.\d+)?)\s*,?\s*$/.exec(all[budgetAt] ?? '')
  return {
    lines: picked.map((i) => ({ line: i + 1, text: (all[i] ?? '').trimEnd() })),
    budget: budget ? Number(budget[1]) : null,
  }
}
