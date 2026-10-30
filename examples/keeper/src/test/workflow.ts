import { readFileSync } from 'node:fs'

/** The scheduled workflow that runs the keeper. */
const WORKFLOW = new URL('../../../../.github/workflows/keeper.yml', import.meta.url)

/** The settings the scheduled workflow runs the keeper with, as its env holds them. */
export function workflowEnv(): Record<string, string> {
  const text = readFileSync(WORKFLOW, 'utf8')
  return Object.fromEntries(
    [...text.matchAll(/^\s+([A-Z][A-Z0-9_]*):\s*"([^"]*)"\s*$/gm)].map((m) => [m[1], m[2]]),
  )
}

/** The minutes GitHub gives the workflow's job before it cancels it. */
export function workflowTimeoutMinutes(): number {
  const found = readFileSync(WORKFLOW, 'utf8').match(/^\s+timeout-minutes:\s*(\d+)\s*$/m)
  if (!found?.[1]) throw new Error('The keeper workflow sets no timeout-minutes')
  return Number(found[1])
}
