import { quotedLabel } from '@avow-finance/spec'
import { renderUnicodeCompact } from 'uqr'
import { approvalLink, connectToBusiness } from '../sandbox/connect.js'
import { fileStore } from './platform.js'

/** What `avow-sandbox connect` takes, read from its arguments, or why it can't run. */
export function readConnectArgs(
  args: readonly string[],
): { businessId: string | null; label: string; sell: boolean } | { error: string } {
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
  // With no --business, whoever opens the link signs in, or sets up their business, and approves.
  return { businessId, label, sell }
}

/**
 * `avow-sandbox connect [--business <id>] [--sell]`. Connects the agent in this folder to a business,
 * with its own key kept in .avow here, and waits while the administrator approves it in the console.
 * Without `--business`, the person who opens the link signs in, or sets up their business, there.
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
    ...(read.businessId ? { businessId: read.businessId } : {}),
    label: read.label,
    sell: read.sell,
    signal: stop.signal,
    onEvent: (event) => {
      if (event.type === 'asked') {
        const link = approvalLink(event.agentKey)
        console.log(
          [
            event.businessId
              ? `Asked ${event.businessId} for authority, as ${quotedLabel(event.label)}.`
              : `Asked for authority, as ${quotedLabel(event.label)}, from whichever business approves it.`,
            '',
            `  Pairing code  ${event.pairingCode}`,
            '',
            event.businessId
              ? 'Open this to review and approve it, on your phone or here. The console shows the same code.'
              : 'Open this on your phone or here, sign in or set up your business, and approve. The console shows the same code.',
            '',
            `  ${link}`,
            '',
            // A phone can scan the link from a terminal a person is watching. An agent reading the
            // output relays the link instead, so it gets no block art.
            ...(process.stdout.isTTY ? [renderUnicodeCompact(link), ''] : []),
            "This agent's key stays in .avow in this folder. Avow and the console never see it.",
          ].join('\n'),
        )
      } else if (event.type === 'waiting' && !told) {
        told = true
        console.log(
          'Waiting for the approval. Leave this running, or stop it and run connect again later.',
        )
      } else if (event.type === 'bound') {
        console.log(`Approved for ${event.businessId}.`)
      } else if (event.type === 'approved') {
        console.log(`Approved as ${event.agentId}. Picking up its authority from Avow.`)
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
