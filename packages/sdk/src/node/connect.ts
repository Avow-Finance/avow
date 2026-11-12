import { connectToBusiness, SANDBOX_CONSOLE_URL } from '../sandbox/connect.js'
import { fileStore } from './platform.js'

/** What `avow-sandbox connect` takes, read from its arguments, or why it can't run. */
export function readConnectArgs(
  args: readonly string[],
): { businessId: string; label: string; sell: boolean } | { error: string } {
  let businessId: string | null = null
  let label = 'My agent'
  let sell = false
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    const value = args[i + 1]
    if (flag === '--sell') {
      sell = true
      continue
    }
    if (
      (flag === '--business' || flag === '--name') &&
      (value === undefined || value.startsWith('--'))
    ) {
      return { error: `${flag} needs a value` }
    }
    if (flag === '--business') businessId = value ?? null
    else if (flag === '--name') label = value ?? label
    else return { error: `connect doesn't take ${flag}` }
    i++
  }
  if (!businessId) {
    return {
      error: `connect needs --business, the business ID your console shows at ${SANDBOX_CONSOLE_URL}`,
    }
  }
  return { businessId, label, sell }
}

/**
 * `avow-sandbox connect --business <id> [--sell]`. Connects the agent in this folder to a business,
 * with its own key kept in .avow here, and waits while the administrator approves it in the console.
 * With `--sell` it also makes a signing key to quote and accept jobs for the business with.
 */
export async function connectCommand(args: readonly string[]): Promise<void> {
  const read = readConnectArgs(args)
  if ('error' in read) {
    console.error(read.error)
    process.exit(1)
  }
  const stop = new AbortController()
  process.once('SIGINT', () => stop.abort(new Error('Stopped waiting')))
  let told = false
  const item = await connectToBusiness({
    store: fileStore(),
    businessId: read.businessId,
    label: read.label,
    sell: read.sell,
    signal: stop.signal,
    onEvent: (event) => {
      if (event.type === 'asked') {
        console.log(
          [
            `Asked ${event.businessId} for authority, as "${read.label}".`,
            '',
            `  Pairing code  ${event.pairingCode}`,
            '',
            `Approve it at ${SANDBOX_CONSOLE_URL} and check the console shows the same code.`,
            "This agent's key stays in .avow in this folder. Avow and the console never see it.",
          ].join('\n'),
        )
      } else if (event.type === 'waiting' && !told) {
        told = true
        console.log(
          'Waiting for the approval. Leave this running, or stop it and run connect again later.',
        )
      } else if (event.type === 'approved') {
        console.log(`Approved as ${event.agentId}. Enrolling with Avow.`)
      } else if (event.type === 'supplier') {
        console.log(`Registered signing key ${event.signingKey} to sell for the business.`)
      }
    },
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
  const m = item.mandate.message
  console.log(
    `Connected. This agent can commit for ${m.businessId} within the limits its administrator signed, until ${new Date(Number(m.expiry) * 1000).toISOString()}.`,
  )
}
