import type { AvowDomain, SandboxDeployment, SessionEvent } from '@avow-finance/spec'
import type { Look, Rail } from '@avow-finance/terminal'
import { Account } from 'viem/tempo'
import { agentRequestKey } from '../http.js'
import { sessionReporter } from '../sandbox/agent.js'
import { cancelSandboxCommitment, type SandboxPrompts } from '../sandbox/setup.js'
import { loadAgentItem, type SandboxStore } from '../sandbox/store.js'
import { liveWorld } from '../session/live-world.js'
import { selectProvider } from '../session/selection.js'
import { runSession, type SessionInput } from '../session/session.js'
import type { JobWorld } from '../session/world.js'
import { readServicePolicy, runCheckBeforeWork } from './service-process.js'
import { railView } from './session-view.js'

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
}

/** Reads `--provider`, `--model` and `--scripted`, refusing anything else. */
export function readJobFlags(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): JobFlags | { error: string } {
  const flags: JobFlags = {
    provider: env.AVOW_MODEL_PROVIDER?.trim() || null,
    model: env.AVOW_MODEL?.trim() || null,
    scripted: false,
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
  prompts: Pick<SandboxPrompts, 'passphrase'>
  input: SessionInput | null
  /** The world to run in, the live sandbox unless a test hands it another. */
  world?: JobWorld
  write?: (text: string) => void
  /** The service file and the folder it's in, `service.ts` in the working directory by default. */
  service?: { file: string; cwd: string }
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
        cancelFree: (commitmentId) =>
          cancelSandboxCommitment({ commitmentId, prompts: o.prompts, store, deployment }),
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
  const view = railView(rail, o.look, { fixture: world.kind === 'fixture', write })
  const emit = (event: SessionEvent) => {
    view.event(event)
    if (world.kind === 'live') post(event)
  }
  rail.stage(o.mode === 'one' ? 'One job, with no input' : 'Your agent session')
  const result = await runSession({
    world,
    provider: chosen.provider,
    readPolicy: () => readServicePolicy(service.file, service.cwd),
    checkBeforeWork: async (job) =>
      runCheckBeforeWork(service.file, job, await world.chainFor(job), service.cwd),
    emit,
    view,
    input: o.mode === 'one' ? null : o.input,
    nextRun: o.nextRun,
  })
  if (result.stopped) return 1
  const ended = result.firstJob
  if (o.mode === 'one') {
    rail.close(
      ended?.kind === 'paid'
        ? 'The job is done and paid. Both reserves come back by themselves at their release dates.'
        : ended?.kind === 'refused'
          ? `The customer refused the quote with ${ended.refusal.code}, so no work started.`
          : ended?.kind === 'not_started'
            ? `Your side didn't accept the job, with ${ended.code} at the ${ended.layer} layer, so no work started.`
            : ended?.kind === 'stopped'
              ? ended.why
              : 'No quote went out, so the job ended there.',
    )
    return ended?.kind === 'paid' ? 0 : 1
  }
  return 0
}
