import type { ModelReport } from './run.js'
import { SCENARIOS } from './scenarios.js'

/**
 * The results as the docs page shows them: one row per model as the endpoint served it, one column
 * per scenario, then each failure with the criteria it missed.
 */
export function resultsTable(reports: readonly ModelReport[]): string {
  const ids = SCENARIOS.map((s) => s.id)
  const head = ['Model', 'Date', ...ids, 'Passed', 'Cost']
  const rows = reports.map((r) => {
    const cells = ids.map((id) => {
      const s = r.scenarios.find((x) => x.id === id)
      return !s
        ? 'not run'
        : s.passed
          ? 'pass'
          : s.error && s.criteria.length === 0
            ? 'error'
            : 'fail'
    })
    const passed = r.scenarios.filter((s) => s.passed).length
    return [
      servedName(r),
      r.date,
      ...cells,
      `${passed} of ${ids.length}`,
      r.usage.cost === null ? 'not reported' : `$${r.usage.cost.toFixed(2)}`,
    ]
  })
  const line = (cells: readonly string[]) => `| ${cells.join(' | ')} |`
  const table = [line(head), line(head.map(() => '---')), ...rows.map(line)].join('\n')
  const misses = reports.flatMap((r) =>
    r.scenarios
      .filter((s) => !s.passed)
      .map((s) => {
        const missed = s.criteria.filter((c) => !c.passed).map((c) => c.name)
        const why = [...missed, ...(s.error ? [`stopped: ${s.error}`] : [])].join('; ')
        return `- ${servedName(r)}, ${s.id}: ${why}. Called ${s.calls.join(', ') || 'no tools'}.`
      }),
  )
  return misses.length === 0 ? table : `${table}\n\n${misses.join('\n')}`
}

/** The model as asked, followed by the version the endpoint served when it names another. */
function servedName(r: ModelReport): string {
  const other = r.served.filter((m) => m !== r.model)
  return other.length === 0 ? r.model : `${r.model} (${other.join(', ')})`
}
