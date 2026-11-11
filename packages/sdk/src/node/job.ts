import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  type AvowDomain,
  formatUsd,
  type SandboxDeployment,
  type SessionEvent,
} from '@avow-finance/spec'
import type { Look, Rail } from '@avow-finance/terminal'
import { Account } from 'viem/tempo'
import { agentRequestKey } from '../http.js'
import { moderatoTransactionUrl } from '../moderato.js'
import { sessionReporter } from '../sandbox/agent.js'
import { cancelSandboxCommitment, type SandboxPrompts } from '../sandbox/setup.js'
import { loadAgentItem, type SandboxStore } from '../sandbox/store.js'
import { liveWorld } from '../session/live-world.js'
import { selectProvider } from '../session/selection.js'
import { runSession, type SessionInput } from '../session/session.js'
import type { JobWorld } from '../session/world.js'
import { firstRunGuide, outcomeLine } from './first-run.js'
import { serviceExcerpt } from './service-excerpt.js'
import { readServicePolicy, runCheckBeforeWork } from './service-process.js'
import { localClock, railView } from './session-view.js'

/**
 * The job chapter in the terminal: `npm start` runs the agent session once setup is done, and
 * `npm run job` runs one job with no input. Both pick the model as `selectProvider` does, say which
 * model and who pays before the first call, and run against the live sandbox.
 */

export const SERVICE_FILE = 'service.ts'

/** The session's flags, read from the command line and the environment. */
export interface JobFlags {
  provider: string | null
  model: string | null
  scripted: boolean
  /** `--details`: every tool call, receipt, address and link, as the screen shows them. */
  details: boolean
}

/** Reads `--provider`, `--model`, `--scripted` and `--details`, refusing anything else. */
export function readJobFlags(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): JobFlags | { error: string } {
  const flags: JobFlags = {
    provider: env.AVOW_MODEL_PROVIDER?.trim() || null,
    model: env.AVOW_MODEL?.trim() || null,
    scripted: false,
    details: false,
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    const [name, inline] = arg.split('=', 2) as [string, string | undefined]
    const value = () => {
      const v = inline ?? args[++i]
      if (!v || v.startsWith('--')) throw new Error(`${name} needs a value`)
      return v
    }
    try {
      if (name === '--scripted') flags.scripted = true
      else if (name === '--details') flags.details = true
      else if (name === '--provider') flags.provider = value()
      else if (name === '--model') flags.model = value()
      else return { error: `There's no option ${arg} here.` }
    } catch (error) {
      return { error: (error as Error).message }
    }
  }
  return flags
}

export async function runJobSession(o: {
  mode: 'interactive' | 'one'
  flags: JobFlags
  rail: Rail
  look: Look
  store: SandboxStore
  deployment: SandboxDeployment
  dir: string
  session: { id: string }
  nextRun: () => number
  prompts: Pick<SandboxPrompts, 'passphrase' | 'confirm'>
  input: SessionInput | null
  /** The world to run in, the live sandbox unless a test hands it another. */
  world?: JobWorld
  write?: (text: string) => void
  /** The service file and the folder it's in, `service.ts` in the working directory by default. */
  service?: { file: string; cwd: string }
  /** A first run, which goes on from setup's two steps as steps 3 to 5 of 5. */
  firstRun?: boolean
}): Promise<number> {
  const { rail, store, deployment } = o
  const write = o.write ?? ((text: string) => void process.stdout.write(text))
  const service = o.service ?? { file: SERVICE_FILE, cwd: process.cwd() }
  const chosen = await selectProvider({ ...o.flags, env: process.env })
  if (!chosen.ok) {
    rail.fail(chosen.why)
    for (const line of chosen.help) rail.quiet(line)
    return 1
  }
  let world: JobWorld
  try {
    world =
      o.world ??
      (await liveWorld({
        store,
        deployment,
        cancelFree: async (booking, onLock) => {
          // The developer sees what's being cancelled before the passphrase is asked for.
          const left = Number((onLock.freeCancelBy - onLock.block.timestamp) / 60n)
          const sure = await o.prompts.confirm(
            `Your agent asks to cancel booking ${booking.id}. Cancel it?`,
            [
              `${booking.gpus} ${booking.offer.gpu} of ${booking.offer.id} from ${booking.offer.supplier}, with ${formatUsd(booking.reserve)} reserved.`,
              `Free cancellation is still open, for about ${Math.max(left, 0)} more minutes, so cancelling gives the whole reserve back.`,
              "Only your business's key can cancel on the lock, so it asks for your passphrase next.",
            ],
          )
          if (!sure) return null
          return cancelSandboxCommitment({
            commitmentId: booking.reference.commitmentId,
            prompts: o.prompts,
            store,
            deployment,
          })
        },
      }))
  } catch (error) {
    rail.fail(error instanceof Error ? error.message : String(error))
    return 1
  }
  // The session's events go to the screen signed by the agent's key, as its runs' events do.
  const agent = await loadAgentItem(store)
  const post = agent
    ? sessionReporter({
        session: { id: o.session.id, run: 1 },
        key: agentRequestKey(
          Account.fromSecp256k1(agent.agentKey, { access: agent.business.account }),
        ),
        domain: {
          chainId: deployment.chainId,
          verifyingContract: agent.business.lock,
        } as AvowDomain,
        apiUrl: deployment.apiUrl,
        fetch: (input, init) => fetch(input, init),
        log: (line) => rail.quiet(line),
      })
    : () => {}
  const brief = !o.flags.details
  const view = railView(rail, o.look, { fixture: world.kind === 'fixture', write, brief })
  // A first run goes on from setup's two steps, with a guide for steps 3 to 5, and ends on the
  // service file's deciding lines.
  const guided = o.firstRun === true && o.mode === 'interactive' && o.input !== null
  const excerpt = guided
    ? await readFile(resolve(service.cwd, service.file), 'utf8').then(serviceExcerpt, () => null)
    : null
  const guide =
    guided && o.input !== null
      ? firstRunGuide({
          rail,
          input: o.input,
          clock: localClock,
          write,
          transactionUrl: world.kind === 'live' ? moderatoTransactionUrl : null,
          modelHelp: chosen.fallback ? (chosen.fallback.help[0] ?? null) : null,
          code: excerpt ? { file: service.file, excerpt } : null,
        })
      : null
  const emit = (event: SessionEvent) => {
    view.event(event)
    if (world.kind === 'live') post(event)
    guide?.watch(event)
  }
  if (guide) guide.start()
  else if (o.mode === 'one') rail.stage('One job, with no input')
  // A guided run's Model line names the scripted decisions, and how to get a model comes at the end.
  if (chosen.fallback && !guide) {
    rail.quiet(chosen.fallback.why)
    for (const line of chosen.fallback.help) rail.quiet(line)
  }
  const result = await runSession({
    world,
    provider: chosen.provider,
    readPolicy: () => readServicePolicy(service.file, service.cwd),
    checkBeforeWork: async (job) =>
      runCheckBeforeWork(service.file, job, await world.chainFor(job), service.cwd),
    emit,
    view,
    input: guide ? guide.input : o.mode === 'one' ? null : o.input,
    nextRun: o.nextRun,
    brief,
    ...(guide
      ? {
          afterJob: (outcome) => guide.afterJob(outcome),
          withoutCompute: guide.withoutCompute,
          scenario: guide.scenario,
        }
      : {}),
  })
  if (result.stopped) return 1
  const ended = result.firstJob
  if (o.mode === 'one') {
    rail.close(outcomeLine(ended, localClock))
    return ended?.kind === 'paid' ? 0 : 1
  }
  return 0
}
