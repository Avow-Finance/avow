import type { Rail } from '@avow-finance/terminal'
import type { SessionInput } from '../session/session.js'

/**
 * What the developer types to the agent, on the rail's "you ›" line. A line typed while the agent
 * or the executor is busy waits for the next turn, and when something is in flight it gets a notice
 * saying typing can't undo it.
 */
export function terminalInput(
  prompts: {
    ask(prompt: string, hidden?: boolean): Promise<string | null>
    onLine(listener: (line: string) => void): void
  },
  rail: Pick<Rail, 'quiet' | 'settle' | 'you'>,
): SessionInput {
  const typed: string[] = []
  let waiting: ((line: string | null) => void) | null = null
  let flying: string | null = null
  prompts.onLine((line) => {
    if (flying) rail.quiet(`Typing can't undo ${flying}. What you typed applies once it's done.`)
    if (waiting) {
      const resolve = waiting
      waiting = null
      resolve(line)
    } else typed.push(line)
  })
  return {
    inFlight(what) {
      flying = what
    },
    next() {
      const queued = typed.shift()
      if (queued !== undefined) return Promise.resolve(queued)
      rail.settle()
      return new Promise((resolve) => {
        waiting = resolve
        prompts.ask(rail.you).then((line) => {
          if (waiting === resolve) {
            waiting = null
            resolve(line)
          }
        })
      })
    },
  }
}
