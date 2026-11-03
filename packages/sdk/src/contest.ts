import {
  answersCharge,
  type ChargeKind,
  CONTEST_REASONS,
  type ContestReason,
  type ContestStatement,
  type ContestStatementAnswer,
  contestStatementHash,
  parseContestStatement,
  type ReasonCode,
} from '@avow-finance/spec'
import {
  contestInLogs,
  LOCK_ABI,
  type LockedBacking,
  type ObservedContest,
  readBacking,
  readContest,
} from '@avow-finance/verifier'
import {
  type Address,
  type Chain,
  type Client,
  type Hex,
  isAddressEqual,
  type TransactionReceipt,
  type Transport,
} from 'viem'
import { getBlock, readContract } from 'viem/actions'
import type { Account as TempoAccount } from 'viem/tempo'
import type { BusinessRecords } from './avow-api.js'
import { AvowApiError } from './http.js'
import { type Call, contestCall } from './lock.js'
import { type OnSent, SEND_LIMITS, type SendLimits, sendOwn } from './send.js'

/**
 * How long, in seconds, a contest sent now may take to land. The root key sends it on an expiring
 * nonce, which viem keeps valid for 25 seconds from when it's prepared, so a contest of a pending
 * charge goes out only while its window stays open that long past the latest block.
 */
export const CONTEST_SEND_MARGIN = 25n

/**
 * Why the lock won't take the business's contest of a commitment in a block up to `landsBy`, by the
 * chain's clock, or null when it will. The lock takes one contest per commitment, of a pending
 * charge until its contest window closes, or of a report Avow hasn't confirmed or referred at any
 * time. `contest` passes the latest block's time plus `CONTEST_SEND_MARGIN`.
 */
export function contestProblem(held: LockedBacking, landsBy: bigint): ReasonCode | null {
  // A contest stays on record when the supplier withdraws the report, and a later report pauses
  // at once, so a contested commitment the lock still holds takes no second contest.
  if (held.contested && (held.state === 'paused' || held.state === 'accepted')) {
    return 'contest.already_contested'
  }
  const pending = held.state === 'charge_pending'
  if (!pending && !(held.state === 'accepted' && held.hasReport)) return 'contest.not_contestable'
  if (pending && landsBy >= held.chargeStart + held.contestWindow) return 'contest.window_closed'
  return null
}

/** What contesting a charge needs: the business account's root key, its lock and Avow. */
export interface ContestConfig {
  /** A client for the chain the business's lock is on, with the chain's fee token set. */
  client: Client<Transport, Chain>
  /** The business account's root key, the one key the lock takes a direct contest from. */
  root: TempoAccount.RootAccount
  /** The business's lock. */
  lock: Address
  /** Avow's records the root key gives the statement to, as `httpBusinessRecords` serves them. */
  avow: BusinessRecords
  /**
   * Sends calls from the root key, which pays its own fee, and resolves with the receipt once they
   * land. By default the key signs locally and the hash is tracked through `sendOwn`, which throws
   * a `SendError` when the transaction fails or its outcome is unknown. A test passes its own.
   */
  send?: (calls: readonly Call[], onSent: OnSent) => Promise<TransactionReceipt>
  limits?: SendLimits
}

/** One contest the business makes. */
export interface ContestRequest {
  commitmentId: Hex
  reason: ContestReason
  /** The business's account in its own words, which the statement carries. */
  text: string
  /**
   * Called with the statement and the contest transaction's hash before its bytes go out, and
   * awaited, so a caller can keep what it needs to settle a run that stops before the end.
   */
  onSent?: (sent: SentContest) => unknown
}

/** A contest whose transaction is going out, before anyone has seen it land. */
export interface SentContest {
  statement: ContestStatement
  hash: Hex
  /** The first block time at which the transaction can no longer land, or null when it has none. */
  validBefore: bigint | null
}

/** A contest the lock took, with when it paused the charge and how long Avow has to rule. */
export interface LandedContest {
  statement: ContestStatement
  statementHash: Hex
  transactionHash: Hex
  /** The charge the contested report names, with its amount in base units of the lock's token. */
  charge: { kind: ChargeKind; amount: bigint }
  /** When the lock paused the charge, which days 30 and 90 count from. */
  pausedAt: bigint
  /** When Avow's ruling key stops, the pause plus the lock's `rulingKeyEnd`. Avow rules before it. */
  ruleBy: bigint
}

/** Whether Avow recorded the statement, with when, or the error that stopped it. */
export type StatementPosting = { ok: true; recordedAt: bigint } | { ok: false; error: Error }

/**
 * A contest's outcome. A refusal comes before anything is sent. Once the lock takes the contest,
 * it stands whatever happens to the statement, so the result carries the contest with whether Avow
 * recorded the statement, which `postContestStatement` can give Avow again at any time.
 */
export type ContestResult =
  | { ok: false; reason: ReasonCode }
  | { ok: true; contest: LandedContest; posted: StatementPosting }

/**
 * How many times a statement goes to Avow while Avow doesn't see the contest final yet. With the
 * default wait of two seconds between tries, that gives the contest's block about 18 seconds to
 * reach Avow's node and become final, many times what Tempo's finality takes.
 */
export const STATEMENT_TRIES = 10

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The latest block's time, which the lock judges a contest window by. */
async function chainTime(client: Client): Promise<bigint> {
  return (await getBlock(client, { blockTag: 'latest' })).timestamp
}

/** The lock's `rulingKeyEnd`, which the factory fixed and no call changes. */
function rulingKeyEnd(client: Client, lock: Address): Promise<bigint> {
  return readContract(client, { address: lock, abi: LOCK_ABI, functionName: 'rulingKeyEnd' })
}

/** The business account that owns the lock, the one account whose root key can contest on it. */
function lockAccount(client: Client, lock: Address): Promise<Address> {
  return readContract(client, { address: lock, abi: LOCK_ABI, functionName: 'account' })
}

/** The report a contest named, with its charge, as the lock held it when the contest landed. */
interface ContestedReport {
  number: number
  kind: ChargeKind | null
  amount: bigint
}

/**
 * The contest a statement made, from the lock's event and the report it named, or a throw when
 * the event isn't the one the statement's contest logs or names another report. The lock logs its
 * event in the transaction that took the contest, so an event that differs means the transaction
 * carried another contest than the statement's.
 */
function landedFrom(
  seen: ObservedContest | null,
  statement: ContestStatement,
  facts: { transactionHash: Hex; report: ContestedReport; rulingKeyEnd: bigint },
): LandedContest {
  const statementHash = contestStatementHash(statement)
  const { kind, number, amount } = facts.report
  if (
    !seen ||
    !kind ||
    number !== statement.reportNumber ||
    seen.reasonCode !== CONTEST_REASONS[statement.reason].code ||
    seen.statementHash !== statementHash
  ) {
    throw new Error(
      `${facts.transactionHash} holds no contest of ${statement.commitmentId} with this statement`,
    )
  }
  return {
    statement,
    statementHash,
    transactionHash: facts.transactionHash,
    charge: { kind, amount },
    pausedAt: seen.pausedAt,
    ruleBy: seen.pausedAt + facts.rulingKeyEnd,
  }
}

/**
 * Gives Avow the statement for a contest the lock took, and returns Avow's answer. Avow records a
 * statement only once the contest's block is final, and its node can be a block behind the one
 * that gave the contest's receipt, so while Avow answers that the transaction holds no contest yet,
 * it asks again, up to `STATEMENT_TRIES` times. Any other
 * refusal, or no definite answer, throws an `AvowApiError`. Avow keeps one statement per
 * commitment, so posting the same statement again is always safe.
 */
export async function postContestStatement(
  avow: BusinessRecords,
  contest: Pick<LandedContest, 'statement' | 'transactionHash'>,
  limits: SendLimits = SEND_LIMITS,
): Promise<ContestStatementAnswer> {
  for (let i = 1; ; i++) {
    try {
      return await avow.postContestStatement({
        statement: contest.statement,
        contestedIn: contest.transactionHash,
      })
    } catch (e) {
      const unseen = e instanceof AvowApiError && e.reason === 'contest.not_on_chain'
      if (!unseen || i >= STATEMENT_TRIES) throw e
      await sleep(limits.wait)
    }
  }
}

/**
 * Contests a charge with the business account's root key and gives Avow the statement. It reads
 * the lock first and refuses, sending nothing, a commitment the lock doesn't hold
 * (`chain.reserve_missing`), one already contested, one with no pending charge or standing report,
 * and a pending charge whose contest window closes within `CONTEST_SEND_MARGIN` of the latest
 * block's time, since a contest sent then could land too late. It also refuses a reason that
 * doesn't answer the kind of charge reported and a statement the format doesn't take, since a
 * contest can't be taken back. It throws, sending nothing, when the root key isn't
 * the account that owns the lock.
 *
 * Then it sends the lock's `contest` from the root key, which pays its own fee, signed locally and
 * tracked by its hash, with `onSent` told before the bytes go out. A send that fails or whose
 * outcome is unknown throws the sender's `SendError`. Once the receipt shows the contest landed, it
 * posts the statement to Avow, signed by the root key. The contest stands whether or not that
 * works, so the result carries it either way, with whether Avow recorded the statement.
 */
export async function contest(
  config: ContestConfig,
  request: ContestRequest,
): Promise<ContestResult> {
  const { client, lock } = config
  const limits = config.limits ?? SEND_LIMITS
  const commitmentId = request.commitmentId.toLowerCase() as Hex
  const [held, now, keyEnd, account] = await Promise.all([
    readBacking(client, lock, commitmentId, 'buyer'),
    chainTime(client),
    rulingKeyEnd(client, lock),
    lockAccount(client, lock),
  ])
  if (!isAddressEqual(account, config.root.address)) {
    throw new Error(
      `The lock ${lock} belongs to the account ${account}, so the root key ${config.root.address} can't contest on it`,
    )
  }
  if (!held) return { ok: false, reason: 'chain.reserve_missing' }
  const problem = contestProblem(held, now + CONTEST_SEND_MARGIN)
  if (problem) return { ok: false, reason: problem }
  if (!held.reportKind || !answersCharge(request.reason, held.reportKind)) {
    return { ok: false, reason: 'contest.reason_not_for_charge' }
  }
  const parsed = parseContestStatement({
    commitmentId,
    side: 'buyer',
    reportNumber: held.reportCount,
    reason: request.reason,
    text: request.text,
  })
  if (!parsed.ok) return { ok: false, reason: parsed.reason }
  const statement = parsed.value

  const send =
    config.send ??
    ((calls, onSent) => sendOwn({ client, account: config.root, calls, onSent, limits }))
  const receipt = await send([contestCall(lock, statement)], (hash, validBefore) =>
    request.onSent?.({ statement, hash, validBefore }),
  )
  // The lock took the contest only while it named the report read above, so that's its charge.
  const landed = landedFrom(contestInLogs(receipt.logs, lock, commitmentId, 'buyer'), statement, {
    transactionHash: receipt.transactionHash,
    report: { number: held.reportCount, kind: held.reportKind, amount: held.reportAmount },
    rulingKeyEnd: keyEnd,
  })
  let posted: StatementPosting
  try {
    const answer = await postContestStatement(config.avow, landed, limits)
    posted = { ok: true, recordedAt: answer.recordedAt }
  } catch (e) {
    posted = { ok: false, error: e instanceof Error ? e : new Error(String(e)) }
  }
  return { ok: true, contest: landed, posted }
}

/**
 * Reads a contest a successful transaction carried, as `contest` returns it, so a caller that
 * stopped after sending can settle it from the chain. The charge is the one the contested report
 * named, read from the lock as of the contest's block, so a report the supplier filed after
 * withdrawing that one never reads as the charge contested. It returns null when the transaction
 * isn't on the chain, failed, or holds no contest of the statement's commitment from the lock, and
 * throws when the transaction carried a contest with another reason, statement or report.
 */
export async function readLandedContest(
  config: Pick<ContestConfig, 'client' | 'lock'>,
  statement: ContestStatement,
  transactionHash: Hex,
): Promise<LandedContest | null> {
  const { client, lock } = config
  const { commitmentId, side } = statement
  const [seen, keyEnd] = await Promise.all([
    readContest(client, lock, commitmentId, side, transactionHash),
    rulingKeyEnd(client, lock),
  ])
  if (!seen) return null
  return landedFrom(seen, statement, { transactionHash, report: seen.report, rulingKeyEnd: keyEnd })
}
