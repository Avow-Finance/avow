import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AvowApiError,
  type Commitment,
  type ContestRequest,
  type ContestResult,
  type LandedContest,
  SendError,
} from '@avow-finance/sdk'
import { type ContestStatement, contestStatementHash, type ReasonCode } from '@avow-finance/spec'
import { formatTime } from '@avow-finance/verifier'
import type { Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type ContestDeps, contestArgs, contestBooking } from './contest.js'
import { BuyerStore } from './store.js'
import { fundedBooking, id, LOCK } from './test/bookings.js'

// Every key is generated for the run, and every state directory is removed after its test.
const TX: Hex = id('the contest transaction')
const EARLIER_TX: Hex = id('a contest an earlier run sent')
const PAUSED_AT = 1_800_000_900n
const RULE_BY = PAUSED_AT + 1800n
const RECORDED_AT = PAUSED_AT + 5n
const TEXT = 'Our agent sent the start request on time, and the supplier receipted it.'

let dir: string
let store: BuyerStore
let booking: Commitment
let logged: string[]
let asked: ContestRequest[]
let postedAgain: LandedContest[]
/** What the SDK's contest does: refuse, land with or without Avow recording, or throw. */
let contestDoes: { refuse: ReasonCode } | { posted: true | Error } | { throws: Error }
/** What posting the statement again does. */
let postDoes: 'recorded' | Error
let receipts: Map<Hex, 'success' | 'reverted'>
let finalizedNow: bigint
/** What reading a contest from its transaction finds. */
let landedOnChain: LandedContest | null

const statementFor = (c: Commitment, change: Partial<ContestStatement> = {}): ContestStatement => ({
  commitmentId: c.commitmentId,
  side: 'buyer',
  reportNumber: 1,
  reason: 'job_started',
  text: TEXT,
  ...change,
})
const landedFor = (statement: ContestStatement, transactionHash = TX): LandedContest => ({
  statement,
  statementHash: contestStatementHash(statement),
  transactionHash,
  charge: { kind: 'noShow', amount: 500_000_000n },
  pausedAt: PAUSED_AT,
  ruleBy: RULE_BY,
})
const refusal = (reason: ReasonCode, definite = true) =>
  new AvowApiError(`refused: ${reason}`, {
    status: definite ? 503 : 0,
    reason,
    requestId: id('a request'),
    definite,
  })

function deps(): ContestDeps {
  return {
    store,
    async contest(request): Promise<ContestResult> {
      asked.push(request)
      if ('refuse' in contestDoes) return { ok: false, reason: contestDoes.refuse }
      const statement = statementFor(booking, { reason: request.reason, text: request.text })
      await request.onSent?.({ statement, hash: TX, validBefore: PAUSED_AT + 25n })
      // The store names the transaction before its bytes go anywhere.
      expect(store.contest(booking.commitmentId)).toEqual({
        statement,
        sent: { hash: TX, validBefore: PAUSED_AT + 25n },
      })
      if ('throws' in contestDoes) throw contestDoes.throws
      const posted = contestDoes.posted
      return {
        ok: true,
        contest: landedFor(statement),
        posted:
          posted === true ? { ok: true, recordedAt: RECORDED_AT } : { ok: false, error: posted },
      }
    },
    async post(contest) {
      postedAgain.push(contest)
      if (postDoes instanceof Error) throw postDoes
      return { recordedAt: RECORDED_AT + 60n }
    },
    landed: async () => landedOnChain,
    receipt: async (hash) => receipts.get(hash) ?? null,
    finalizedTime: async () => finalizedNow,
    log: (line) => logged.push(line),
  }
}

const args = (change: Partial<Parameters<typeof contestBooking>[1]> = {}) => ({
  commitmentId: null,
  reason: 'job_started' as const,
  text: TEXT,
  ...change,
})

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'avow-buyer-contest-'))
  store = new BuyerStore(dir)
  store.saveSetup({ lock: LOCK })
  booking = await fundedBooking()
  store.saveBooking(booking)
  logged = []
  asked = []
  postedAgain = []
  contestDoes = { posted: true }
  postDoes = 'recorded'
  receipts = new Map()
  finalizedNow = PAUSED_AT
  landedOnChain = null
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("contest's arguments", () => {
  const ID = `0x${'5c'.repeat(32)}`

  it('takes the reason and the statement, and the commitment id anywhere or not at all', () => {
    const given = { reason: 'other', text: 'Something else happened.' }
    expect(contestArgs(['--reason', 'other', '--statement', given.text])).toEqual({
      commitmentId: null,
      ...given,
    })
    expect(contestArgs([ID, '--reason', 'other', '--statement', given.text])).toEqual({
      commitmentId: ID,
      ...given,
    })
    expect(
      contestArgs([
        '--statement',
        given.text,
        '--reason',
        'other',
        ID.toUpperCase().replace('0X', '0x'),
      ]),
    ).toEqual({
      commitmentId: ID,
      ...given,
    })
  })

  it('refuses a reason that is not one of the six, naming them', () => {
    expect(() => contestArgs(['--reason', 'not_mine', '--statement', 'x'])).toThrow(
      "not_mine isn't a reason. Use one of never_cancelled, cancelled_in_time, job_started, supplier_did_not_provide, wrong_charge, other.",
    )
  })

  it('refuses missing, repeated or unknown flags, two ids and a bad id', () => {
    const usage = 'Usage: contest [commitmentId] --reason <reason> --statement "<text>"'
    for (const given of [
      [],
      ['--reason', 'other'],
      ['--statement', 'x'],
      ['--reason', 'other', '--statement'],
      ['--reason', 'other', '--reason', 'other', '--statement', 'x'],
      ['--reason', 'other', '--statement', 'x', '--evidence', 'y'],
      [ID, ID, '--reason', 'other', '--statement', 'x'],
    ]) {
      expect(() => contestArgs(given), given.join(' ')).toThrow(usage)
    }
    expect(() => contestArgs(['0x1234', '--reason', 'other', '--statement', 'x'])).toThrow(
      "0x1234 isn't a commitment id, 32 bytes of hex",
    )
  })
})

describe('contesting the latest booking', () => {
  it("contests with the root key, saves the contest with Avow's time, and says when Avow must rule", async () => {
    const contest = await contestBooking(deps(), args())
    const statement = statementFor(booking)
    const saved = { ...landedFor(statement), recordedAt: RECORDED_AT }
    expect(contest).toEqual(saved)
    expect(store.contest(booking.commitmentId)).toEqual(saved)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({
      commitmentId: booking.commitmentId,
      reason: 'job_started',
      text: TEXT,
    })
    expect(logged.slice(1)).toEqual([
      `contested a no-show charge of USD 500 on ${booking.commitmentId}, report 1, saying the business showed up and the job started (job_started)`,
      `the lock paused the charge at ${formatTime(PAUSED_AT)}, in ${TX}`,
      `Avow must rule by ${formatTime(RULE_BY)}, and after that the arbiter rules`,
      `Avow recorded the statement at ${formatTime(RECORDED_AT)}`,
    ])
  })

  it('contests the booking named, and refuses one the store lacks or that was never funded', async () => {
    const other = await fundedBooking(1_800_000_060n)
    store.saveBooking(other)
    expect(
      (await contestBooking(deps(), args({ commitmentId: booking.commitmentId }))).statement
        .commitmentId,
    ).toBe(booking.commitmentId)
    const missing = id('a booking nobody made')
    await expect(contestBooking(deps(), args({ commitmentId: missing }))).rejects.toThrow(
      `holds no booking for ${missing}`,
    )
    const { reservedIn: _, ...approved } = await fundedBooking(1_800_000_120n)
    store.saveBooking({ ...approved, outcome: 'failed' })
    await expect(
      contestBooking(deps(), args({ commitmentId: approved.commitmentId })),
    ).rejects.toThrow('was never funded, so it has nothing to contest')
  })

  it('refuses before book has made anything', async () => {
    rmSync(join(dir, 'bookings'), { recursive: true })
    store = new BuyerStore(dir)
    await expect(contestBooking(deps(), args())).rejects.toThrow(
      'holds no booking yet. Run book first.',
    )
  })

  it('explains every refusal, and saves nothing', async () => {
    const explained: [ReasonCode, string][] = [
      ['chain.reserve_missing', 'The lock holds no reserve for'],
      ['contest.already_contested', 'The business has already contested a charge on'],
      ['contest.not_contestable', 'The lock holds no pending charge and no standing report on'],
      [
        'contest.window_closed',
        'closes within the 25 seconds a contest sent now could take to land, so the charge can no longer be contested',
      ],
      [
        'contest.reason_not_for_charge',
        'never_cancelled and cancelled_in_time answer a late cancellation',
      ],
      ['contest.statement_invalid', 'at most 4000 bytes of UTF-8'],
      ['message.invalid', '(message.invalid)'],
    ]
    for (const [reason, says] of explained) {
      contestDoes = { refuse: reason }
      await expect(contestBooking(deps(), args()), reason).rejects.toThrow(says)
      expect(store.contest(booking.commitmentId)).toBeNull()
    }
  })
})

describe('giving Avow the statement', () => {
  it('saves a contest Avow did not record, says it stands, and gives Avow the statement on the next run', async () => {
    contestDoes = { posted: refusal('service.unavailable') }
    await expect(contestBooking(deps(), args())).rejects.toThrow(
      `Avow didn't record the statement (refused: service.unavailable). The contest of ${booking.commitmentId} stands and the charge stays paused. Run contest again to give Avow the statement, which is safe to repeat.`,
    )
    const landed = landedFor(statementFor(booking))
    expect(store.contest(booking.commitmentId)).toEqual({ ...landed, recordedAt: null })
    // What happened still shows before the error.
    expect(logged).toContain(
      `Avow must rule by ${formatTime(RULE_BY)}, and after that the arbiter rules`,
    )

    logged = []
    const again = await contestBooking(deps(), args())
    expect(asked).toHaveLength(1)
    expect(postedAgain).toEqual([{ ...landed, recordedAt: null }])
    expect(again.recordedAt).toBe(RECORDED_AT + 60n)
    expect(store.contest(booking.commitmentId)).toEqual({
      ...landed,
      recordedAt: RECORDED_AT + 60n,
    })
    expect(logged[0]).toBe(
      `${booking.commitmentId} is contested, so Avow is given the statement again`,
    )
  })

  it('says when Avow gave no definite answer, and keeps the contest to post again', async () => {
    contestDoes = { posted: refusal('service.unavailable', false) }
    await expect(contestBooking(deps(), args())).rejects.toThrow(
      'Avow gave no definite answer about the statement',
    )
    postDoes = refusal('service.unavailable', false)
    await expect(contestBooking(deps(), args())).rejects.toThrow('gave no definite answer')
    expect(store.contest(booking.commitmentId)).toMatchObject({ recordedAt: null })
  })

  it('asks neither the lock nor Avow again once Avow has recorded the statement', async () => {
    await contestBooking(deps(), args())
    logged = []
    const again = await contestBooking(deps(), args({ reason: 'other', text: 'Other words.' }))
    expect(again.recordedAt).toBe(RECORDED_AT)
    expect(asked).toHaveLength(1)
    expect(postedAgain).toEqual([])
    expect(logged[0]).toBe(
      `${booking.commitmentId} already has a contest with its own reason and statement, which can't change, so the ones given aren't used`,
    )
    expect(logged[1]).toBe(
      `${booking.commitmentId} is already contested, so the lock isn't asked again`,
    )
  })
})

describe('a contest an earlier run sent', () => {
  const sentEarlier = (validBefore: bigint | null = PAUSED_AT + 25n) =>
    store.saveContest(booking.commitmentId, {
      statement: statementFor(booking),
      sent: { hash: EARLIER_TX, validBefore },
    })

  it('settles one that landed from its receipt, and gives Avow its statement', async () => {
    sentEarlier()
    receipts.set(EARLIER_TX, 'success')
    landedOnChain = landedFor(statementFor(booking), EARLIER_TX)
    const contest = await contestBooking(deps(), args())
    expect(asked).toEqual([])
    expect(contest).toEqual({ ...landedOnChain, recordedAt: RECORDED_AT + 60n })
    expect(logged).toContain(`the contest of ${booking.commitmentId} sent in ${EARLIER_TX} landed`)
  })

  it('stops when the receipt shows success but the chain shows no contest in it', async () => {
    sentEarlier()
    receipts.set(EARLIER_TX, 'success')
    await expect(contestBooking(deps(), args())).rejects.toThrow(
      `${EARLIER_TX} landed, but the chain shows no contest of ${booking.commitmentId} in it`,
    )
  })

  it('stops while one may still land', async () => {
    sentEarlier()
    await expect(contestBooking(deps(), args())).rejects.toThrow(
      `The contest of ${booking.commitmentId} sent in ${EARLIER_TX} may still land. Run contest again in a minute.`,
    )
    sentEarlier(null)
    finalizedNow = PAUSED_AT + 3600n
    await expect(contestBooking(deps(), args())).rejects.toThrow('may still land')
    expect(asked).toEqual([])
  })

  it('forgets one that reverted or expired, and contests afresh', async () => {
    sentEarlier()
    receipts.set(EARLIER_TX, 'reverted')
    expect((await contestBooking(deps(), args())).transactionHash).toBe(TX)
    expect(logged).toContain(
      `the contest of ${booking.commitmentId} sent in ${EARLIER_TX} never landed`,
    )

    const second = await fundedBooking(1_800_000_060n)
    store.saveBooking(second)
    booking = second
    sentEarlier(PAUSED_AT + 25n)
    finalizedNow = PAUSED_AT + 26n
    expect((await contestBooking(deps(), args())).transactionHash).toBe(TX)
    expect(asked).toHaveLength(2)
  })
})

describe('a contest that fails on its way', () => {
  it("forgets a contest that failed, and says the charge isn't paused", async () => {
    contestDoes = {
      throws: new SendError(`The transaction ${TX} reverted`, 'failed', {
        hashes: [TX],
        signings: 1,
      }),
    }
    await expect(contestBooking(deps(), args())).rejects.toThrow(
      `The contest of ${booking.commitmentId} failed, so the charge isn't paused (The transaction ${TX} reverted). Run contest again, which reads the lock first.`,
    )
    expect(store.contest(booking.commitmentId)).toBeNull()
  })

  it('keeps a contest whose outcome is unknown, to settle from its receipt', async () => {
    contestDoes = {
      throws: new SendError(`No receipt for ${TX} after waiting`, 'unknown', {
        hashes: [TX],
        signings: 1,
      }),
    }
    await expect(contestBooking(deps(), args())).rejects.toThrow(
      `Whether the contest of ${booking.commitmentId} landed is unknown. Run contest again, which settles it from the transaction's receipt.`,
    )
    expect(store.contest(booking.commitmentId)).toMatchObject({ sent: { hash: TX } })
  })

  it('passes any other error on as it is', async () => {
    const odd = new Error('the node is on another chain')
    contestDoes = { throws: odd }
    await expect(contestBooking(deps(), args())).rejects.toBe(odd)
  })
})
