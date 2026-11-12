import { type MailboxOrder, mailboxStatusAt } from '@avow-finance/spec'
import { MAILBOX_ORDER_SECONDS, sandboxMailbox } from '../sandbox/mailbox.js'
import { fileStore } from './platform.js'

/** What `avow-sandbox order` takes, read from its arguments, or why it can't run. */
export function readOrderArgs(
  args: readonly string[],
): { supplier: string; expiresIn: bigint } | { error: string } {
  let supplier: string | null = null
  let expiresIn = MAILBOX_ORDER_SECONDS
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]
    const value = args[i + 1]
    if (value === undefined || value.startsWith('--')) return { error: `${flag} needs a value` }
    if (flag === '--supplier') supplier = value
    else if (flag === '--expires-in' && /^[1-9][0-9]{0,4}$/.test(value)) expiresIn = BigInt(value)
    else if (flag === '--expires-in') return { error: '--expires-in takes whole seconds' }
    else return { error: `order doesn't take ${flag}` }
  }
  if (!supplier) return { error: 'order needs --supplier, the business ID of the agent that sells' }
  return { supplier, expiresIn }
}

const describe = (order: MailboxOrder) =>
  `${order.orderId} for ${order.supplierBusinessId}, ${mailboxStatusAt(order, BigInt(Math.floor(Date.now() / 1000)))}`

/**
 * `avow-sandbox order --supplier <id>`. Orders the demo job from another business and sees it
 * through: waits for the quote, checks it, funds the commitment and waits for the acceptance.
 */
export async function orderCommand(args: readonly string[]): Promise<void> {
  const read = readOrderArgs(args)
  if ('error' in read) {
    console.error(read.error)
    process.exit(1)
  }
  const stop = new AbortController()
  process.once('SIGINT', () => stop.abort(new Error('Stopped waiting')))
  const mailbox = await sandboxMailbox({ store: fileStore() })
  const outcome = await mailbox.buy({
    supplier: read.supplier,
    expiresIn: read.expiresIn,
    signal: stop.signal,
    onStep: (step) => {
      if (step.step === 'ordered')
        console.log(`Ordered ${describe(step.order)}. Nothing is reserved.`)
      else if (step.step === 'quoted')
        console.log('Quoted. Checking the terms and the booking they rely on.')
      else if (step.step === 'reserved') console.log('Funded. Waiting for the supplier to accept.')
      else console.log('Accepted.')
    },
  })
  if (!outcome.ok) {
    console.error(`Stopped at ${describe(outcome.order)}: ${outcome.reason}`)
    process.exit(1)
  }
}

/**
 * `avow-sandbox listen`. Reads this business's inbox every few seconds and takes each order's next
 * step, until stopped. Orders that arrive while it isn't running wait in the inbox until they lapse.
 */
export async function listenCommand(): Promise<void> {
  const stop = new AbortController()
  process.once('SIGINT', () => stop.abort())
  const mailbox = await sandboxMailbox({ store: fileStore() })
  console.log(`Listening for orders to ${mailbox.businessId}. Stop with Ctrl+C.`)
  await mailbox.listen({
    signal: stop.signal,
    onStep: (order, step) => console.log(`${order.orderId}: ${step.step}`),
    onError: (order, error) =>
      console.error(`${order.orderId}: ${error instanceof Error ? error.message : String(error)}`),
  })
}
