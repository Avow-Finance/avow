import { CHARGE_KINDS, type ChargeKind, RELEASE_REASONS, type ReleaseReason } from './eip712.js'

/**
 * What a lock writes in its logs: the arguments of each log, and the word for each number a log
 * carries. A commitment event stated from a block is written from these and from nothing else, so
 * this module is all a reader of a lock's logs needs beside the lock's address.
 */

/**
 * Every log a lock writes about a commitment, with its arguments in order and the Solidity type of
 * each. `commitmentId` is indexed in every one of them. A lock also logs changes to its own
 * settings, which belong to no commitment and are left out here.
 *
 * `PaymentOwed` is written inside a step, just before the step's own log, when the lock's transfer
 * of an amount failed and the lock recorded the amount as owed to `party`. A step that sends
 * nothing, or whose transfer went through, writes none.
 */
export const LOCK_LOGS = {
  Reserved: {
    commitmentId: 'bytes32',
    side: 'uint8',
    termsHash: 'bytes32',
    mandateHash: 'bytes32',
    amount: 'uint256',
    supplier: 'address',
    payout: 'address',
    fundedBy: 'address',
    approvalNonce: 'uint256',
    approvalHash: 'bytes32',
  },
  Accepted: {
    commitmentId: 'bytes32',
    side: 'uint8',
    termsHash: 'bytes32',
    acceptanceHash: 'bytes32',
  },
  Released: {
    commitmentId: 'bytes32',
    side: 'uint8',
    termsHash: 'bytes32',
    cause: 'uint8',
    reason: 'uint8',
    evidenceHash: 'bytes32',
    returned: 'uint256',
  },
  Reported: {
    commitmentId: 'bytes32',
    side: 'uint8',
    termsHash: 'bytes32',
    reportNumber: 'uint8',
    kind: 'uint8',
    amount: 'uint256',
    evidenceHash: 'bytes32',
    deadline: 'uint64',
    contested: 'bool',
  },
  ReportWithdrawn: {
    commitmentId: 'bytes32',
    side: 'uint8',
    termsHash: 'bytes32',
    reportNumber: 'uint8',
    evidenceHash: 'bytes32',
  },
  ChargeConfirmed: {
    commitmentId: 'bytes32',
    side: 'uint8',
    termsHash: 'bytes32',
    reportNumber: 'uint8',
    amount: 'uint256',
    evidenceHash: 'bytes32',
    returned: 'uint256',
  },
  Referred: {
    commitmentId: 'bytes32',
    side: 'uint8',
    termsHash: 'bytes32',
    reportNumber: 'uint8',
    evidenceHash: 'bytes32',
    returned: 'uint256',
  },
  Paused: {
    commitmentId: 'bytes32',
    side: 'uint8',
    termsHash: 'bytes32',
    cause: 'uint8',
    pausedAt: 'uint64',
    reasonCode: 'uint16',
    evidenceHash: 'bytes32',
    returned: 'uint256',
  },
  EvidenceFiled: {
    commitmentId: 'bytes32',
    side: 'uint8',
    termsHash: 'bytes32',
    filer: 'uint8',
    number: 'uint16',
    evidenceHash: 'bytes32',
  },
  RulingPosted: {
    commitmentId: 'bytes32',
    side: 'uint8',
    termsHash: 'bytes32',
    by: 'address',
    toSupplier: 'uint256',
    evidenceHash: 'bytes32',
  },
  Charged: {
    commitmentId: 'bytes32',
    side: 'uint8',
    termsHash: 'bytes32',
    amount: 'uint256',
    evidenceHash: 'bytes32',
  },
  Resolved: {
    commitmentId: 'bytes32',
    side: 'uint8',
    termsHash: 'bytes32',
    byRuling: 'bool',
    toSupplier: 'uint256',
    toBusiness: 'uint256',
    evidenceHash: 'bytes32',
  },
  PaymentOwed: { commitmentId: 'bytes32', side: 'uint8', party: 'uint8', amount: 'uint256' },
  OwedWithdrawn: {
    commitmentId: 'bytes32',
    side: 'uint8',
    party: 'uint8',
    to: 'address',
    amount: 'uint256',
  },
} as const satisfies Record<string, Record<string, string>>

export type LockLogName = keyof typeof LOCK_LOGS

/** A log's signature as Solidity declares it, which a chain client parses into the log's ABI. */
export function lockLogSignature(name: LockLogName): string {
  const args = Object.entries(LOCK_LOGS[name]).map(
    ([arg, type]) => `${type}${arg === 'commitmentId' ? ' indexed' : ''} ${arg}`,
  )
  return `event ${name}(${args.join(', ')})`
}

/**
 * Why a reserve went back to the business, by the code a `Released` log carries as its `cause`.
 * Avow returns a reserve the supplier hasn't accepted. The business takes its reserve back before
 * free cancellation ends. The supplier's account consents to give it back. A reserve nobody
 * accepted goes back at the acceptance deadline, and one with nothing reported at its release date.
 */
export const RELEASE_CAUSES = {
  returned_by_avow: 0,
  cancelled_in_time: 1,
  supplier_consent: 2,
  not_accepted: 3,
  reached_release_date: 4,
} as const
export type ReleaseCause = keyof typeof RELEASE_CAUSES

/**
 * What paused a charge, by the code a `Paused` log carries as its `cause`. A referral pauses a
 * charge too, and has a log of its own, so no `Paused` log carries its code.
 */
export const PAUSE_CAUSES = { referral: 1, timeout: 2, contest: 3, avowPause: 4 } as const
export type PauseCause = keyof typeof PAUSE_CAUSES

/**
 * The two parties to a commitment, by the code a lock logs for who filed a piece of evidence and
 * for who a payment is for. The business is the one that reserved.
 */
export const LOCK_PARTIES = { business: 0, supplier: 1 } as const
export type LockParty = keyof typeof LOCK_PARTIES

/** The word a table gives a lock's number, or null for a number the table doesn't list. */
const wordOf =
  <W extends string>(table: Readonly<Record<W, number>>) =>
  (code: number): W | null =>
    (Object.keys(table) as W[]).find((word) => table[word] === code) ?? null

/** The cause a `Released` log's code stands for, or null for a code that names none. */
export const releaseCauseOf = wordOf<ReleaseCause>(RELEASE_CAUSES)

/**
 * The reason a supplier's consent gave, from the code a `Released` log carries as its `reason`, or
 * null for a code that names none. Only a release by the supplier's consent carries one of these.
 * Avow gives a number of its own when it returns a reserve, which this table says nothing about.
 */
export const releaseReasonOf = wordOf<ReleaseReason>(RELEASE_REASONS)

/** The cause a `Paused` log's code stands for, or null for a code that names none. */
export const pauseCauseOf = wordOf<PauseCause>(PAUSE_CAUSES)

/** The party a lock's code stands for, or null for a code that names none. */
export const lockPartyOf = wordOf<LockParty>(LOCK_PARTIES)

/**
 * The kind of charge a lock's code stands for, or null for a code that names none. A lock holds up
 * to four kinds, and this package names two of them.
 */
export const chargeKindOf = wordOf<ChargeKind>(CHARGE_KINDS)
