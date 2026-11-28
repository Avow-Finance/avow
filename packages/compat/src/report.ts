import type { ModelReport } from './run.js'
import { SCENARIOS } from './scenarios.js'

/**
 * The results as the docs page shows them: one row per model as the endpoint served it, one column
 * per scenario with the trials it passed out of those it ran, then each failed trial with the
 * criteria it missed.
 */
export function resultsTable(reports: readonly ModelReport[]): string {
  const ids = SCENARIOS.map((s) => s.id)
  const head = ['Model', 'Date', ...ids, 'Passed', 'Cost']
  const rows = reports.map((r) => {
    const cells = ids.map((id) => {
      const s = r.scenarios.find((x) => x.id === id)
      if (!s || s.trials.length === 0) return r.error ? 'error' : 'not run'
      if (s.trials.every((t) => t.criteria.length === 0 && t.error)) return 'error'
      return `${s.trials.filter((t) => t.passed).length} of ${s.trials.length}`
    })
    const every = r.scenarios.filter((s) => s.trials.length > 0 && s.trials.every((t) => t.passed))
    return [
      servedName(r),
      r.date,
      ...cells,
      `${every.length} of ${ids.length}`,
      r.usage.cost === null ? 'not reported' : `$${r.usage.cost.toFixed(2)}`,
    ]
  })
  const line = (cells: readonly string[]) => `| ${cells.join(' | ')} |`
  const table = [line(head), line(head.map(() => '---')), ...rows.map(line)].join('\n')
  const misses = reports.flatMap((r) => [
    ...(r.error ? [`- ${servedName(r)}: stopped: ${r.error}`] : []),
    ...r.scenarios.flatMap((s) =>
      s.trials.flatMap((t, i) => {
        if (t.passed) return []
        const missed = t.criteria.filter((c) => !c.passed).map((c) => c.name)
        const why = [...missed, ...(t.error ? [`stopped: ${t.error}`] : [])].join('; ')
        const calls = t.calls.join(', ') || 'no tools'
        return [`- ${servedName(r)}, ${s.id}, trial ${i + 1}: ${why}. Called ${calls}.`]
      }),
    ),
  ])
  return misses.length === 0 ? table : `${table}\n\n${misses.join('\n')}`
}

/** The model as asked, followed by the version the endpoint served when it names another. */
function servedName(r: ModelReport): string {
  const other = r.served.filter((m) => m !== r.model)
  return other.length === 0 ? r.model : `${r.model} (${other.join(', ')})`
}
