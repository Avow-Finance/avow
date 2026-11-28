import { type Address, type Hex, toEventSelector } from 'viem'
import {
  type BlockEvent,
  type CommitmentEventCode,
  type CommitmentEventFact,
  commitmentEvent,
} from './commitment-event.js'
import { COMMITMENT_EVENT_LOGS } from './commitment-event-log.js'
import { contestReasonOf } from './contest.js'
import { SIDE_CODES } from './eip712.js'
import {
  chargeKindOf,
  LOCK_LOG_ABI,
  LOCK_LOGS,
  type LockLog,
  type LockLogName,
  type LockParty,
  lockPartyOf,
  PAUSE_CAUSES,
  type PauseCause,
  RELEASE_CAUSES,
  type ReceiptLog,
  readLockLog,
  releaseCauseOf,
  releaseReasonOf,
  sentStates,
  stepOwed,
} from './lock-log.js'

/**
 * Where a receipt was read, which none of its logs carry: the chain, the lock whose logs are read,
 * the block and its time, and the transaction.
 */
export interface LockReceiptPlace {
  chainId: number
  /** The lock whose logs become events. Logs from any other address are left alone. */
  lock: Address
  blockNumber: bigint
  /** The time of the block, in unix seconds. */
  at: bigint
  transactionHash: Hex
}

/** What one receipt holds for one lock. */
export interface LockReceiptEvents {
  /** An event for each of the lock's steps on a commitment, in the order of their logs. */
  events: BlockEvent[]
  /**
   * The index of each log of the lock that names one of its commitment logs and still makes no
   * event, in the order of the receipt. That is a log of a commitment log's signature that doesn't
   * decode, a step this package can't state, such as a `Paused` log with a cause it doesn't know or
   * a log for a side no lock reserves, and a `PaymentOwed` that no step's event accounts for, whose
   * step then reads as paid. A reader that meets one knows it holds a log it can't state, and says
   * so.
   */
  unread: number[]
}

/** How one code is read from its log, as `COMMITMENT_EVENT_LOGS` lists it, typed loosely. */
interface Source {
  log: LockLogName
  cause?: PauseCause
  from: Readonly<Record<string, string>>
  sends?: Readonly<Record<string, LockParty>>
}

const SOURCES = Object.entries(COMMITMENT_EVENT_LOGS) as [CommitmentEventCode, Source][]

/** The code a lock's log states, which for a `Paused` log its cause decides, or null for none. */
function codeOf(log: LockLog): [CommitmentEventCode, Source] | null {
  const cause = log.name === 'Paused' ? Number(log.args.cause) : null
  return (
    SOURCES.find(
      ([, s]) => s.log === log.name && (s.cause === undefined || PAUSE_CAUSES[s.cause] === cause),
    ) ?? null
  )
}

/** The words for numbers a log carries, by the field of the event that takes the word. */
const WORDS: Readonly<Record<string, (code: number) => string | null>> = {
  kind: chargeKindOf,
  cause: releaseCauseOf,
  filer: lockPartyOf,
  party: lockPartyOf,
}

/**
 * The commitment events one transaction's receipt states for one lock: one for each of the lock's
 * steps on a commitment, written from the step's own log, the `PaymentOwed` logs that `sentStates`
 * reads from the same receipt, and the place given. It reads nothing else.
 *
 * A block event names a log no reorganization drops, so the caller passes only a receipt from a
 * final block. Logs from other addresses, the lock's `PaymentOwed` logs, which a step folds in, and
 * logs that aren't the lock's commitment logs, such as a change to its settings, make no event, and
 * `unread` names each of the lock's commitment logs that no event accounts for.
 * The receipt's logs are read in the order of their indexes, whatever order they come in.
 */
export function lockReceiptEvents(
  receiptLogs: readonly ReceiptLog[],
  place: LockReceiptPlace,
): LockReceiptEvents {
  const lock = place.lock.toLowerCase()
  const logs = [...receiptLogs].sort((a, b) => a.logIndex - b.logIndex)
  const events: BlockEvent[] = []
  const unread: number[] = []
  const owed: number[] = []
  const folded = new Set<number>()
  for (const log of logs) {
    if (log.address.toLowerCase() !== lock) continue
    const read = readLockLog(log)
    if (!read) {
      // A log with a commitment log's signature that doesn't decode is the lock's, and unread.
      if (LOCK_SELECTORS.has(String(log.topics[0]).toLowerCase())) unread.push(log.logIndex)
      continue
    }
    if (read.name === 'PaymentOwed') {
      owed.push(log.logIndex)
      continue
    }
    const made = eventOf(logs, log, read, place)
    if (!made) {
      unread.push(log.logIndex)
      continue
    }
    events.push(made.event)
    for (const i of made.folds) folded.add(i)
  }
  unread.push(...owed.filter((i) => !folded.has(i)))
  return { events, unread: unread.sort((a, b) => a - b) }
}

/** The first topic of each of the lock's commitment logs. */
const LOCK_SELECTORS = new Set<string>(
  LOCK_LOG_ABI.filter((item) => item.type === 'event').map((e) => toEventSelector(e).toLowerCase()),
)

/**
 * The event one of the lock's logs states, with the `PaymentOwed` logs it accounts for, which are
 * those for a party it sends an amount to, or null when it states none this package can write.
 */
function eventOf(
  logs: readonly ReceiptLog[],
  log: ReceiptLog,
  read: LockLog,
  place: LockReceiptPlace,
): { event: BlockEvent; folds: number[] } | null {
  const found = codeOf(read)
  const states = sentStates(logs, log.logIndex)
  const owed = stepOwed(logs, log.logIndex)
  if (!found || !states || !owed || read.args.side !== SIDE_CODES.buyer) return null
  const [code, { from, sends = {} }] = found
  const args = read.args
  const sentTo = new Set(
    Object.entries(sends)
      .filter(([name]) => args[from[name] as string] !== 0n)
      .map(([, party]) => party),
  )
  const folds = owed.filter((o) => sentTo.has(o.party)).map((o) => o.logIndex)
  const types = LOCK_LOGS[read.name] as Readonly<Record<string, string>>
  const fields = Object.entries(from).map(([name, arg]) => {
    const raw = args[arg]
    const to = sends[name]
    // The lock sends nothing when an amount is zero, so the event carries null in its place.
    if (to) return [name, raw === 0n ? null : { amount: raw, state: states[to] }]
    if (name === 'reason') {
      // A contest's reason is always one of six, and a release names a reason only by consent.
      const byConsent = args.cause === RELEASE_CAUSES.supplier_consent
      const word =
        code === 'charge.contested'
          ? contestReasonOf(Number(raw))
          : byConsent
            ? releaseReasonOf(Number(raw))
            : null
      return [name, word]
    }
    const word = WORDS[name]
    if (word) return [name, word(Number(raw))]
    return [name, types[arg] === 'address' || types[arg] === 'bytes32' ? lower(raw) : raw]
  })
  try {
    const event = commitmentEvent({
      code,
      commitment: {
        chainId: place.chainId,
        lock: place.lock.toLowerCase(),
        commitmentId: lower(args.commitmentId),
      },
      source: 'block',
      at: place.at,
      blockNumber: place.blockNumber,
      transactionHash: lower(place.transactionHash),
      logIndex: log.logIndex,
      ...Object.fromEntries(fields),
    } as CommitmentEventFact) as BlockEvent
    return { event, folds }
  } catch {
    // A field the event refuses, such as a cause or a party with no word, makes no event.
    return null
  }
}

const lower = (v: unknown) => String(v).toLowerCase()
