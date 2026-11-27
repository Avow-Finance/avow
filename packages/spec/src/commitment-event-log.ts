import type { CommitmentEventCode, CommitmentEventFieldName } from './commitment-event.js'
import type { LOCK_LOGS, LockLogName, LockParty, PauseCause } from './lock-log.js'

/** The codes a block can state. */
type LoggedCode = {
  [C in CommitmentEventCode]: CommitmentEventFieldName<C, 'block'> extends never ? never : C
}[CommitmentEventCode]

/** Where one code's fields are read from when a block states it. */
type LogOf<C extends CommitmentEventCode> = {
  [L in LockLogName]: {
    /** The lock's log for the step. */
    log: L
    /** The cause a `Paused` log carries for this step, since three steps share that log. */
    cause?: L extends 'Paused' ? PauseCause : never
    /** The log's argument each of the code's fields is read from. */
    from: Record<CommitmentEventFieldName<C, 'block'>, keyof (typeof LOCK_LOGS)[L]>
    /** The party each amount the step sends goes to, which a `PaymentOwed` log names. */
    sends?: Partial<Record<CommitmentEventFieldName<C, 'block'>, LockParty>>
  }
}[LockLogName]

/**
 * The lock's log each code is written from when a block states it, and the argument of that log
 * each of the code's fields is read from. A field with no argument here doesn't compile, so an
 * event stated from a block carries nothing but what its log holds, what `sentStates` reads from
 * the same receipt and the block's time.
 *
 * An event takes four things from around its log. The chain and the lock's address are where the
 * log was read. The commitment id is the log's `commitmentId`. The block's number, the transaction
 * and the log's index are the log's place, and `at` is the time of that block. Every lock reserves
 * the buyer's side, so a log's `side` is always the buyer's and an event leaves it out.
 *
 * A field that names two arguments of the same log's number, such as `reason` and `reasonCode`,
 * carries the number as written and the word this package has for it, with null for none.
 *
 * `sends` lists the amounts a step sends and the party each goes to. `sentStates` reads the step's
 * receipt and says, for each party, whether the lock paid it or recorded it as owed. An argument of
 * zero is null in the event, since the lock sends nothing then.
 */
export const COMMITMENT_EVENT_LOGS = {
  'reserve.locked': {
    log: 'Reserved',
    from: {
      termsHash: 'termsHash',
      reserve: 'amount',
      approvalHash: 'approvalHash',
      mandateHash: 'mandateHash',
    },
  },
  'reserve.accepted': {
    log: 'Accepted',
    from: { termsHash: 'termsHash', acceptanceHash: 'acceptanceHash' },
  },
  'charge.reported': {
    log: 'Reported',
    from: {
      termsHash: 'termsHash',
      reportNumber: 'reportNumber',
      kind: 'kind',
      kindCode: 'kind',
      amount: 'amount',
      evidenceHash: 'evidenceHash',
      answerBy: 'deadline',
      contested: 'contested',
    },
  },
  'charge.withdrawn': {
    log: 'ReportWithdrawn',
    from: { termsHash: 'termsHash', reportNumber: 'reportNumber', evidenceHash: 'evidenceHash' },
  },
  'charge.confirmed': {
    log: 'ChargeConfirmed',
    from: {
      termsHash: 'termsHash',
      reportNumber: 'reportNumber',
      amount: 'amount',
      evidenceHash: 'evidenceHash',
      returned: 'returned',
    },
    sends: { returned: 'business' },
  },
  'charge.referred': {
    log: 'Referred',
    from: {
      termsHash: 'termsHash',
      reportNumber: 'reportNumber',
      evidenceHash: 'evidenceHash',
      returned: 'returned',
    },
    sends: { returned: 'business' },
  },
  'charge.unanswered': {
    log: 'Paused',
    cause: 'timeout',
    from: {
      termsHash: 'termsHash',
      pausedAt: 'pausedAt',
      evidenceHash: 'evidenceHash',
      returned: 'returned',
    },
    sends: { returned: 'business' },
  },
  'charge.paused': {
    log: 'Paused',
    cause: 'avowPause',
    from: { termsHash: 'termsHash', pausedAt: 'pausedAt', evidenceHash: 'evidenceHash' },
  },
  'charge.contested': {
    log: 'Paused',
    cause: 'contest',
    from: {
      termsHash: 'termsHash',
      reason: 'reasonCode',
      reasonCode: 'reasonCode',
      statementHash: 'evidenceHash',
      pausedAt: 'pausedAt',
      returned: 'returned',
    },
    sends: { returned: 'business' },
  },
  'charge.evidence_filed': {
    log: 'EvidenceFiled',
    from: {
      termsHash: 'termsHash',
      filer: 'filer',
      number: 'number',
      evidenceHash: 'evidenceHash',
    },
  },
  'charge.ruled': {
    log: 'RulingPosted',
    from: {
      termsHash: 'termsHash',
      ruledBy: 'by',
      toSupplier: 'toSupplier',
      evidenceHash: 'evidenceHash',
    },
  },
  'charge.charged': {
    log: 'Charged',
    from: { termsHash: 'termsHash', amount: 'amount', evidenceHash: 'evidenceHash' },
    sends: { amount: 'supplier' },
  },
  'charge.resolved': {
    log: 'Resolved',
    from: {
      termsHash: 'termsHash',
      byRuling: 'byRuling',
      toSupplier: 'toSupplier',
      toBusiness: 'toBusiness',
      evidenceHash: 'evidenceHash',
    },
    sends: { toSupplier: 'supplier', toBusiness: 'business' },
  },
  'reserve.released': {
    log: 'Released',
    from: {
      termsHash: 'termsHash',
      cause: 'cause',
      reason: 'reason',
      reasonCode: 'reason',
      evidenceHash: 'evidenceHash',
      returned: 'returned',
    },
    sends: { returned: 'business' },
  },
  'reserve.owed_paid': { log: 'OwedWithdrawn', from: { party: 'party', amount: 'amount' } },
} as const satisfies { [C in LoggedCode]: LogOf<C> }
