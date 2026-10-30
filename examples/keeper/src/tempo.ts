import {
  SEND_LIMITS,
  SendError,
  type SendLimits,
  sendOwn,
  TRIGGER_ABI,
  triggerCall,
} from '@avow-finance/sdk'
import { SIDE_CODES, type Side } from '@avow-finance/spec'
import { FACTORY_EVENTS_ABI, LOCK_EVENTS_ABI } from '@avow-finance/verifier'
import {
  type AbiEvent,
  type Account,
  type Address,
  BaseError,
  type Chain,
  type Client,
  decodeErrorResult,
  decodeEventLog,
  getAddress,
  type Hex,
  isHex,
  numberToHex,
  type RpcLog,
  type Transport,
  toEventSelector,
} from 'viem'
import { call, getBlock } from 'viem/actions'
import { Actions } from 'viem/tempo'
import { type BlockRange, type KeeperChain, type SideEvent, TooManyLogsError } from './chain.js'
import { reasonOf } from './report.js'

/** Each side by the code the lock logs for it. */
const SIDES = new Map<number, Side>(
  (Object.entries(SIDE_CODES) as [Side, number][]).map(([side, code]) => [code, side]),
)

/**
 * Whether each lock event the keeper reads opens a side or ends one. A new event in the ABI
 * doesn't compile until it's named here.
 */
const KINDS = {
  Reserved: 'reserved',
  Released: 'ended',
  Charged: 'ended',
  Resolved: 'ended',
} as const satisfies Record<(typeof LOCK_EVENTS_ABI)[number]['name'], SideEvent['kind']>

/** How long the faucet's transfers have to land in. */
const FAUCET_TIMEOUT_MS = 60_000

/**
 * How hard the keeper tries one send. It signs once and waits a minute at most for the outcome, so
 * a send ends well inside a run's time. A step whose transaction lands in no block stays due, and
 * the next run sends it.
 */
export const KEEPER_SEND_LIMITS: SendLimits = {
  ...SEND_LIMITS,
  signings: 1,
  receiptTimeout: 60_000,
}

/** How Moderato's RPC words its refusal of a log query that would return too many logs. */
const TOO_MANY_LOGS = /exceeds max results/

/**
 * The logs of the events in the range from the contracts named, as the node returns them. The
 * caller decodes each one strictly, so a log that has an event's topic and doesn't decode throws.
 * viem's own log filter would drop it, and a dropped reserve would hide a side. A range the node
 * refuses for holding too many logs throws a `TooManyLogsError`, which the keeper splits.
 */
async function logsOf(
  client: Client<Transport, Chain>,
  address: Address | Address[],
  events: readonly AbiEvent[],
  range: BlockRange,
): Promise<RpcLog[]> {
  try {
    return await client.request({
      method: 'eth_getLogs',
      params: [
        {
          address,
          topics: [events.map((event) => toEventSelector(event))],
          fromBlock: numberToHex(range.from),
          toBlock: numberToHex(range.to),
        },
      ],
    })
  } catch (error) {
    const tooMany =
      error instanceof BaseError &&
      error.walk((e) => e instanceof BaseError && TOO_MANY_LOGS.test(e.details))
    if (tooMany) throw new TooManyLogsError(range)
    throw error
  }
}

/** The data a reverted call returned, wherever viem's error carries it. */
function revertData(error: unknown): Hex | undefined {
  if (!(error instanceof BaseError)) return undefined
  const carrier = error.walk((e) => typeof (e as { data?: unknown } | null)?.data === 'string')
  const data = (carrier as { data?: unknown } | null)?.data
  return typeof data === 'string' && isHex(data) ? data : undefined
}

/** Whether revert data is the lock answering that no step is due. */
function isNothingDue(data: Hex): boolean {
  try {
    return decodeErrorResult({ abi: TRIGGER_ABI, data }).errorName === 'NothingDue'
  } catch {
    return false
  }
}

/** The block explorer the client's chain names, which each sent step's link points into. */
export function explorerOf(client: Client<Transport, Chain>): string {
  const url = client.chain.blockExplorers?.default.url
  if (!url) throw new Error(`The chain ${client.chain.id} names no block explorer`)
  return url
}

/**
 * The keeper's chain on Tempo, through a viem client. It sends from `key`, which pays its own fees
 * in the client's fee token. Each transaction is signed locally, valid for under half a minute and
 * followed by its hash, so a run that ends leaves nothing behind that could land later.
 */
export function tempoKeeperChain(args: {
  client: Client<Transport, Chain>
  key: Account
  limits?: SendLimits
}): KeeperChain {
  const { client, key } = args
  return {
    async head() {
      const block = await getBlock(client, { blockTag: 'latest' })
      return { number: block.number, timestamp: block.timestamp }
    },

    async timestampOf(blockNumber) {
      return (await getBlock(client, { blockNumber })).timestamp
    },

    async locksCreated(factory, range) {
      const logs = await logsOf(client, factory, FACTORY_EVENTS_ABI, range)
      return logs.map(({ topics, data }) => {
        const { args } = decodeEventLog({ abi: FACTORY_EVENTS_ABI, topics, data, strict: true })
        return getAddress(args.lock)
      })
    },

    async sideEvents(locks, range) {
      const logs = await logsOf(client, [...locks], LOCK_EVENTS_ABI, range)
      return logs.map(({ address, topics, data }): SideEvent => {
        const event = decodeEventLog({ abi: LOCK_EVENTS_ABI, topics, data, strict: true })
        const side = SIDES.get(event.args.side)
        if (side === undefined) {
          throw new Error(`The lock ${address} logged side ${event.args.side}, which no side has`)
        }
        return {
          lock: getAddress(address),
          commitmentId: event.args.commitmentId,
          side,
          kind: KINDS[event.eventName],
        }
      })
    },

    async isDue(side) {
      try {
        // Simulated from the key that would send it, as the lock would see it.
        await call(client, {
          account: key.address,
          ...triggerCall(side.lock, side.commitmentId, side.side),
        })
        return true
      } catch (error) {
        // Only the lock's NothingDue() means no step is due. Any other revert, a rate limit or a
        // node that doesn't answer leaves the side unchecked, which the run reports.
        const data = revertData(error)
        if (data === undefined) throw error
        if (isNothingDue(data)) return false
        throw new Error(`The lock reverted with ${data}, an error other than NothingDue()`, {
          cause: error,
        })
      }
    },

    async fund() {
      await Actions.faucet.fundSync(client, { account: key.address, timeout: FAUCET_TIMEOUT_MS })
    },

    async send(side) {
      try {
        const receipt = await sendOwn({
          client,
          account: key,
          calls: [triggerCall(side.lock, side.commitmentId, side.side)],
          limits: args.limits ?? KEEPER_SEND_LIMITS,
        })
        return { outcome: 'landed', hash: receipt.transactionHash }
      } catch (error) {
        if (error instanceof SendError && error.outcome === 'unknown') {
          return { outcome: 'unknown', reason: reasonOf(error), hashes: error.hashes }
        }
        // The sender throws a SendError for everything once the key has signed, so any other
        // error came before a transaction existed.
        return { outcome: 'failed', reason: reasonOf(error) }
      }
    },
  }
}
