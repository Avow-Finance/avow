import { SendError, type SendLimits, sendOwn, triggerCall } from '@avow-finance/sdk'
import { SIDE_CODES, type Side } from '@avow-finance/spec'
import { FACTORY_EVENTS_ABI, LOCK_EVENTS_ABI } from '@avow-finance/verifier'
import {
  type AbiEvent,
  type Account,
  type Address,
  BaseError,
  type Chain,
  type Client,
  decodeEventLog,
  ExecutionRevertedError,
  getAddress,
  numberToHex,
  type RpcLog,
  type Transport,
  toEventSelector,
} from 'viem'
import { call, getBlock } from 'viem/actions'
import { Actions } from 'viem/tempo'
import type { BlockRange, KeeperChain, SideEvent } from './chain.js'
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
 * The logs of the events in the range from the contracts named, as the node returns them. The
 * caller decodes each one strictly, so a log that has an event's topic and doesn't decode throws.
 * viem's own log filter would drop it, and a dropped reserve would hide a side.
 */
async function logsOf(
  client: Client<Transport, Chain>,
  address: Address | Address[],
  events: readonly AbiEvent[],
  range: BlockRange,
): Promise<RpcLog[]> {
  return client.request({
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
        // The lock reverts when no step is due. Any other error says nothing about the step.
        if (error instanceof BaseError && error.walk((e) => e instanceof ExecutionRevertedError)) {
          return false
        }
        throw error
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
          ...(args.limits ? { limits: args.limits } : {}),
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
