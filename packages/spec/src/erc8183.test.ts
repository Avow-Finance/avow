import { describe, expect, it } from 'vitest'
import {
  type Commitment,
  type CommitmentFields,
  type CommitmentState,
  type ContestRecord,
  ENDINGS,
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
import { ARBITER, id, LOCK, newKey, PAYEE, START, TOKEN } from './test-helpers.js'
import { COMMITMENT_RECORD_VERSION } from './version.js'

const terms = testnetDemoTerms(START, ARBITER)
const SALT = `0x${'44'.repeat(32)}` as const
const reserve = terms.backing.amount
const fields: CommitmentFields = {
  schemaVersion: COMMITMENT_RECORD_VERSION,
  commitmentId: id('commitment-1'),
  category: 'compute',
  buyer: { businessId: 'biz_buyer', agentId: 'agt_1', mandateId: id('mandate-1') },
  supplier: { businessId: 'biz_supplier', agentId: null },
  terms,
  termsHash: termsHash(terms, SALT),
  backing: [],
  start: null,
  references: [],
}
const contest: ContestRecord = {
  reasonCode: 'supplier_did_not_deliver',
  statementHash: id('contest statement'),
  evidenceHashes: [id('job log')],
  contestedAt: START + 900n,
}

/** A record that ended in `kind`, having charged `charged` micros of the reserve. */
function ended(kind: OutcomeKind, charged: bigint): Commitment {
  const ending = OUTCOME_ENDINGS[kind]
  const locked = kind === 'expired' ? 0n : reserve
  return {
    ...fields,
    state: ending,
    contest: ending === 'resolved' ? contest : null,
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

describe('commitments as ERC-8183 jobs', () => {
  it('moves a job only as ERC-8183 allows, for every move a commitment makes', () => {
    const moves = (from: Erc8183Status, to: Erc8183Status) =>
      from === to || ERC8183_TRANSITIONS[from].includes(to)
    for (const [from, targets] of Object.entries(TRANSITIONS) as [
      CommitmentState,
      readonly CommitmentState[],
    ][]) {
      if (!live(from)) continue
      const start = ERC8183_STATUS_OF[from as keyof typeof ERC8183_STATUS_OF]
      for (const to of targets) {
        const ends = live(to)
          ? [ERC8183_STATUS_OF[to as keyof typeof ERC8183_STATUS_OF]]
          : OUTCOME_KINDS.filter((k) => OUTCOME_ENDINGS[k] === to).flatMap((k) =>
              chargesFor(k).map((charged) => erc8183Status(ended(k, charged))),
            )
        for (const end of ends) {
          expect(moves(start, end), `${from} to ${to} moves a job from ${start} to ${end}`).toBe(
            true,
          )
        }
      }
    }
  })

  it('ends a job by what the supplier was paid, with a kept commitment expiring', () => {
    expect(erc8183Status(ended('no_show', reserve))).toBe('Completed')
    expect(erc8183Status(ended('cancelled_late', reserve / 2n))).toBe('Completed')
    expect(erc8183Status(ended('ruled', reserve / 2n))).toBe('Completed')
    expect(erc8183Status(ended('day_90_default', reserve / 2n))).toBe('Completed')
    expect(erc8183Status(ended('ruled', 0n))).toBe('Rejected')
    expect(erc8183Status(ended('kept', 0n))).toBe('Expired')
    for (const kind of ['cancelled_in_time', 'supplier_failed', 'not_accepted', 'agent_revoked']) {
      expect(erc8183Status(ended(kind as OutcomeKind, 0n))).toBe('Rejected')
    }
    // A commitment whose approval lapsed never reached the lock, so no money moves.
    expect(erc8183Status(ended('expired', 0n))).toBe('Rejected')
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

  it('shows the reserve as the budget, the release date as the expiry and what each side got', () => {
    const account = newKey().address
    const chain = { account, lock: LOCK, payee: PAYEE, decimals: TOKEN.decimals }
    const lock = lockTerms(terms, TOKEN.decimals)
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
})
