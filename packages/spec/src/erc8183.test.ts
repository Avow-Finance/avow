import { describe, expect, it } from 'vitest'
import {
  type BackingRecord,
  CONSENT_OUTCOMES,
  CONSENT_STATES,
  type Commitment,
  type CommitmentFields,
  type CommitmentState,
  type ContestRecord,
  canMove,
  ENDINGS,
  isContested,
  isEnding,
  OUTCOME_ENDINGS,
  type OutcomeKind,
  TRANSITIONS,
} from './commitment.js'
import { testnetDemoTerms } from './demo.js'
import {
  ERC8183_STATUS_OF,
  ERC8183_TRANSITIONS,
  type Erc8183Status,
  erc8183Status,
  toErc8183Job,
} from './erc8183.js'
import { lockTerms, termsHash } from './terms.js'
import { ARBITER, CHAIN_ID, id, LOCK, newKey, PAYEE, START, TOKEN } from './test-helpers.js'
import { COMMITMENT_RECORD_VERSION } from './version.js'

const terms = testnetDemoTerms(START, ARBITER)
const SALT = `0x${'44'.repeat(32)}` as const
const reserve = terms.backing.amount
const lock = lockTerms(terms, TOKEN.decimals)

/** The buyer's reserve as the record's backing holds it, in `lockAt` and paying `payee`. */
const backingIn = (lockAt = LOCK, payee = PAYEE): BackingRecord => ({
  side: 'buyer',
  type: 'cash',
  provider: 'avow-lock',
  enforcement: 'reserve',
  ref: {
    rail: 'tempo',
    chainId: CHAIN_ID,
    lock: lockAt,
    commitmentId: id('commitment-1'),
    side: 'buyer',
    token: TOKEN.token,
    amount: lock.amount,
    payee,
    acceptBy: lock.acceptBy,
    chargeDeadline: lock.chargeDeadline,
    contestWindow: lock.contestWindow,
    releaseDate: lock.releaseDate,
    termsHash: termsHash(terms, SALT),
  },
  status: 'accepted',
})

const fields: CommitmentFields = {
  schemaVersion: COMMITMENT_RECORD_VERSION,
  commitmentId: id('commitment-1'),
  category: 'compute',
  buyer: { businessId: 'biz_buyer', agentId: 'agt_1', mandateId: id('mandate-1') },
  supplier: { businessId: 'biz_supplier', agentId: null },
  terms,
  termsHash: termsHash(terms, SALT),
  backing: [backingIn()],
  start: null,
  references: [],
}
const contest: ContestRecord = {
  reasonCode: 'supplier_did_not_deliver',
  statementHash: id('contest statement'),
  evidenceHashes: [id('job log')],
  contestedAt: START + 900n,
}

/**
 * A record that ended in `kind`, having charged `charged` micros of the reserve, and holding the
 * business's contest when `contested`, as every ruling and day-90 default does.
 */
function ended(
  kind: OutcomeKind,
  charged: bigint,
  contested = OUTCOME_ENDINGS[kind] === 'resolved',
): Commitment {
  const ending = OUTCOME_ENDINGS[kind]
  const locked = kind === 'expired' ? 0n : reserve
  return {
    ...fields,
    backing: kind === 'expired' ? [] : fields.backing,
    state: ending,
    contest: contested ? contest : null,
    outcome: { kind, charged, released: locked - charged },
  } as Commitment
}

/** Every amount a kind of ending can charge: all of the reserve, half of it, or none. */
const chargesFor = (kind: OutcomeKind): bigint[] => {
  const ending = OUTCOME_ENDINGS[kind]
  if (ending === 'charged') return [reserve, reserve / 2n]
  if (ending === 'resolved') return [reserve, reserve / 2n, 0n]
  return [0n]
}

const live = (state: CommitmentState) => !isEnding(state)
const OUTCOME_KINDS = Object.keys(OUTCOME_ENDINGS) as OutcomeKind[]

/**
 * Whether the lock can end a commitment in each kind of outcome before its release date, which is
 * the job's `expiredAt`. Typed over every kind, so a new kind fails the type check here until it
 * says.
 */
const ENDS_BEFORE_RELEASE_DATE: { readonly [K in OutcomeKind]: boolean } = {
  // Avow lets the offer lapse before anything reaches the lock.
  expired: true,
  // The supplier's consent, which the lock takes at any time.
  kept: true,
  supplier_failed: true,
  // Anyone returns a reserve accepted with no report once the release date has come, and no sooner.
  reached_release_date: false,
  cancelled_in_time: true,
  not_accepted: true,
  agent_revoked: true,
  cancelled_late: true,
  no_show: true,
  ruled: true,
  day_90_default: true,
}

describe('commitments as ERC-8183 jobs', () => {
  it('moves a job only as ERC-8183 allows, for every move a commitment makes', () => {
    const allowed = (from: Erc8183Status, to: Erc8183Status) =>
      from === to || ERC8183_TRANSITIONS[from].includes(to)
    const statusOf = (state: CommitmentState) =>
      ERC8183_STATUS_OF[state as keyof typeof ERC8183_STATUS_OF]
    // Every move into an ending, with each kind of outcome that ending holds.
    const endings: { from: CommitmentState; kind: OutcomeKind }[] = []
    for (const [from, targets] of Object.entries(TRANSITIONS) as [
      CommitmentState,
      readonly CommitmentState[],
    ][]) {
      if (!live(from)) continue
      for (const to of targets) {
        if (live(to)) {
          const [start, end] = [statusOf(from), statusOf(to)]
          expect(allowed(start, end), `${from} to ${to} moves a job ${start} to ${end}`).toBe(true)
          continue
        }
        const kinds = OUTCOME_KINDS.filter((kind) => OUTCOME_ENDINGS[kind] === to)
        endings.push(...kinds.map((kind) => ({ from, kind })))
      }
    }
    for (const { from, kind } of endings) {
      const start = statusOf(from)
      for (const charged of chargesFor(kind)) {
        const end = erc8183Status(ended(kind, charged))
        const move = `${from} to ${kind}, charging ${charged}, moves a job ${start} to ${end}`
        expect(allowed(start, end), move).toBe(true)
        // ERC-8183 lets a job expire only once block.timestamp reaches expiredAt.
        if (ENDS_BEFORE_RELEASE_DATE[kind]) expect(end, move).not.toBe('Expired')
      }
    }
  })

  it('shows an early release by consent as a rejection, which the evaluator can make at any time', () => {
    for (const from of CONSENT_STATES) {
      expect(canMove(from, 'released'), from).toBe(true)
      for (const kind of CONSENT_OUTCOMES) {
        // A consent after a contest leaves the contest on the record.
        const status = erc8183Status(ended(kind, 0n, isContested(from)))
        expect(status, `${kind} from ${from}`).toBe('Rejected')
        expect(ERC8183_TRANSITIONS[ERC8183_STATUS_OF[from]]).toContain(status)
      }
    }
  })

  it('expires a job only when the reserve went back at its release date', () => {
    expect(erc8183Status(ended('reached_release_date', 0n))).toBe('Expired')
    for (const kind of OUTCOME_KINDS) {
      if (kind === 'reached_release_date') continue
      for (const charged of chargesFor(kind)) {
        expect(erc8183Status(ended(kind, charged)), kind).not.toBe('Expired')
      }
    }
  })

  it('ends a job by what the supplier was paid', () => {
    expect(erc8183Status(ended('no_show', reserve))).toBe('Completed')
    expect(erc8183Status(ended('cancelled_late', reserve / 2n))).toBe('Completed')
    expect(erc8183Status(ended('ruled', reserve / 2n))).toBe('Completed')
    expect(erc8183Status(ended('day_90_default', reserve / 2n))).toBe('Completed')
    expect(erc8183Status(ended('ruled', 0n))).toBe('Rejected')
    expect(erc8183Status(ended('day_90_default', 0n))).toBe('Rejected')
    for (const kind of [
      'kept',
      'cancelled_in_time',
      'supplier_failed',
      'not_accepted',
      'agent_revoked',
    ] as const) {
      expect(erc8183Status(ended(kind, 0n)), kind).toBe('Rejected')
    }
    // A commitment whose approval lapsed never reached the lock, so no money moves.
    expect(erc8183Status(ended('expired', 0n))).toBe('Rejected')
  })

  it('decides from the state, so a release that charged something still reads as a rejection', () => {
    // parseCommitment refuses this record, and the type alone doesn't.
    const released: Commitment = {
      ...fields,
      state: 'released',
      contest: null,
      outcome: { kind: 'kept', charged: reserve, released: 0n },
    }
    expect(erc8183Status(released)).toBe('Rejected')
  })

  it('keeps every ending a job ending', () => {
    for (const kind of OUTCOME_KINDS) {
      for (const charged of chargesFor(kind)) {
        const status = erc8183Status(ended(kind, charged))
        expect(ERC8183_TRANSITIONS[status]).toEqual([])
      }
    }
    expect(ENDINGS).toHaveLength(4)
  })
})

describe('toErc8183Job', () => {
  const account = newKey().address
  const chain = { account, decimals: TOKEN.decimals }

  it('shows the reserve as the budget, the release date as the expiry and what each side got', () => {
    const funded = toErc8183Job(
      { ...fields, state: 'accepted', contest: null, outcome: null },
      chain,
    )
    expect(funded).toEqual({
      status: 'Funded',
      client: account,
      provider: PAYEE,
      evaluator: LOCK,
      budget: lock.amount,
      expiredAt: lock.releaseDate,
      description: fields.termsHash,
      settled: null,
    })
    const ruled = toErc8183Job(ended('ruled', reserve / 2n), chain)
    expect(ruled.status).toBe('Completed')
    expect(ruled.settled).toEqual({
      paid: lock.amount / 2n,
      refunded: lock.amount - lock.amount / 2n,
    })
  })

  it('names the lock and the payee the reserve was locked with', () => {
    const otherLock = '0x00000000000000000000000000000000000010c5'
    const newPayee = '0x000000000000000000000000000000000000cafe'
    const job = toErc8183Job(
      {
        ...fields,
        backing: [backingIn(otherLock, newPayee)],
        state: 'charge_pending',
        contest: null,
        outcome: null,
      },
      chain,
    )
    expect(job).toMatchObject({ status: 'Submitted', provider: newPayee, evaluator: otherLock })
  })

  it('names no provider or evaluator in a state where no money reached the lock', () => {
    // Avow records the backing it approved before the reserve lands, while the lock has none.
    const approved: BackingRecord = { ...backingIn(), status: 'none' }
    for (const backing of [[], [approved]]) {
      for (const state of ['draft', 'agreed', 'awaiting_approval'] as const) {
        const job = toErc8183Job({ ...fields, backing, state, contest: null, outcome: null }, chain)
        expect(job, state).toMatchObject({ status: 'Open', provider: null, evaluator: null })
      }
      const lapsed = toErc8183Job({ ...ended('expired', 0n), backing }, chain)
      expect(lapsed).toMatchObject({
        status: 'Rejected',
        provider: null,
        evaluator: null,
        settled: { paid: 0n, refunded: 0n },
      })
    }
    // Once the reserve was locked, the job names both, after it ends as well.
    for (const job of [
      toErc8183Job({ ...fields, state: 'reserved', contest: null, outcome: null }, chain),
      toErc8183Job(ended('not_accepted', 0n), chain),
    ]) {
      expect(job).toMatchObject({ provider: PAYEE, evaluator: LOCK })
    }
  })

  it("gives every amount in the token's base units, whatever its decimals", () => {
    // The reserve is $500, and the ruling paid half of it.
    const cases = [
      { decimals: 18, budget: 500n * 10n ** 18n, half: 250n * 10n ** 18n },
      { decimals: 6, budget: 500_000_000n, half: 250_000_000n },
      { decimals: 2, budget: 50_000n, half: 25_000n },
    ]
    for (const { decimals, budget, half } of cases) {
      const job = toErc8183Job(ended('ruled', reserve / 2n), { account, decimals })
      expect(job.budget, `${decimals} decimals`).toBe(budget)
      expect(job.settled, `${decimals} decimals`).toEqual({ paid: half, refunded: budget - half })
    }
  })

  it('throws when an amount cannot be paid exactly in the token', () => {
    // A charge of one micro, a ten-thousandth of a cent.
    expect(() => toErc8183Job(ended('ruled', 1n), { account, decimals: 2 })).toThrow(RangeError)
    expect(() => toErc8183Job(ended('ruled', 1n), { account, decimals: 6 })).not.toThrow()
  })
})
