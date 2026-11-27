import { type MailboxOrder, mailboxStatusAt } from '@avow-finance/spec'
import { MAILBOX_ORDER_SECONDS, sandboxMailbox } from '../sandbox/mailbox.js'
import { SERVICE_ORDERS_UNSERVED, sandboxServices } from '../sandbox/services.js'
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
 * through: waits for the quote, checks it, funds the commitment and waits for the acceptance. An
 * order to that business this agent sent and didn't see through is picked up instead.
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
  // An order this agent sent before it stopped is seen through first, so none is sent twice.
  const left = (await mailbox.unfinished()).find((r) => r.supplierBusinessId === read.supplier)
  if (left) console.log(`Picking up order ${left.orderId}, sent before this agent stopped.`)
  const outcome = await mailbox.buy({
    supplier: read.supplier,
    ...(left ? { resume: left.orderId } : {}),
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
 * `avow-sandbox listen`. Reads this business's inboxes every few seconds and takes each order's
 * next step, until stopped. It quotes a job order, and a service order for an offer this business
 * published. Orders that arrive while it isn't running wait in the inbox until they lapse.
 */
export async function listenCommand(): Promise<void> {
  const stop = new AbortController()
  process.once('SIGINT', () => stop.abort())
  const store = fileStore()
  const [mailbox, services] = await Promise.all([
    sandboxMailbox({ store }),
    sandboxServices({ store }),
  ])
  const offers = await services.published()
  // Asked once up front, so a sandbox that can't carry service orders is said and not polled.
  const unserved = services.sells
    ? await services.inbox().then(
        () => null,
        (error: unknown) =>
          error instanceof Error && error.message === SERVICE_ORDERS_UNSERVED
            ? error.message
            : null,
      )
    : null
  const selling = unserved
    ? `not for services. ${unserved}`
    : offers.length === 0
      ? 'for no services yet, since it has published no offers'
      : `for ${offers.map((v) => v.item.name).join(', ')}`
  console.log(`Listening for orders to ${mailbox.businessId}, for jobs and ${selling}`)
  // Said once up front, and read again before every quote and acceptance.
  if (services.sells && !unserved) {
    console.log(
      await services.sellerStanding().then(
        (standing) => standing.notice,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      ),
    )
  }
  console.log('Stop with Ctrl+C.')
  // A step that fails is tried again on every read, so its reason is said once an order.
  const said = new Set<string>()
  const told = {
    signal: stop.signal,
    onStep: (order: { orderId: string }, step: { step: string }) =>
      console.log(`${order.orderId}: ${step.step}`),
    onError: (order: { orderId: string }, error: unknown) => {
      const line = `${order.orderId}: ${error instanceof Error ? error.message : String(error)}`
      if (!said.has(line)) console.error(line)
      said.add(line)
    },
  }
  if (unserved) return mailbox.listen(told)
  await Promise.all([mailbox.listen(told), services.listen(told)])
}
