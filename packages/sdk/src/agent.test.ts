import {
  type Approval,
  approvalTypedData,
  chainedTerms,
  digestOf,
  dollars,
  gpuReservationTerms,
  PRODUCTION_PROFILE,
  parseTerms,
  type Signed,
  TESTNET_DEMO_PROFILE,
  termsAgreementTypedData,
  termsHash,
  testnetDemoTermsV1,
  toWire,
  verifyApiRequest,
} from '@avow-finance/spec'
import { LOCK_ABI } from '@avow-finance/verifier'
import {
  type Address,
  createClient,
  custom,
  decodeFunctionData,
  encodeFunctionData,
  encodeFunctionResult,
  type Hex,
  recoverAddress,
  toHex,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { Abis, Account } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import { type AgentConfig, BookingError, createAgent } from './agent.js'
import type { AvowApi } from './avow-api.js'
import { agentRequestKey, httpAvowApi } from './http.js'
import { type Call, RESERVE_ABI } from './lock.js'
import { SendError } from './send.js'
import {
  bookingFixture,
  D,
  gpuBooking,
  id,
  LOCK,
  lockRecord,
  NOW,
  START,
  startReceipt,
  TOKEN,
} from './test/fixture.js'

const LANDED_IN = 7n
const quick = { prepareTries: 1, sendTries: 1, signings: 1, wait: 1, receiptTimeout: 50 }

/**
 * A chain that answers reads of the lock with what it holds once the agent's reserve landed, the
 * finalized block at the time a test sets, and receipts for the hashes a test says landed. It
 * records the block every read of the lock named.
 */
function lockChain() {
  const state = {
    holds: null as Approval | null,
    /** What a read as of a past block shows, when a test makes it differ from the latest. */
    heldBefore: undefined as Approval | null | undefined,
    readAt: [] as unknown[],
    /** How many reads of the lock fail before one answers. */
    readErrors: 0,
    /** The finalized block's time, past every approval's expiry unless a test moves it. */
    finalTime: START + 86_400n,
    landed: new Set<string>(),
    /** Hashes whose receipts show a reverted transaction. */
    reverted: new Set<string>(),
  }
  const client = createClient({
    chain: tempoModerato,
    transport: custom(
      {
        async request({ method, params }) {
          if (method === 'eth_getBlockByNumber') {
            return {
              number: toHex(LANDED_IN + 10n),
              timestamp: toHex(state.finalTime),
              hash: id('a block'),
              parentHash: id('its parent'),
              transactions: [],
            }
          }
          if (method === 'eth_getTransactionReceipt') {
            const [hash] = params as [Hex]
            if (!state.landed.has(hash) && !state.reverted.has(hash)) return null
            return {
              status: state.reverted.has(hash) ? '0x0' : '0x1',
              transactionHash: hash,
              blockNumber: toHex(LANDED_IN),
              blockHash: id('a block'),
              logs: [{ address: LOCK, topics: [], data: '0x', logIndex: '0x0' }],
            }
          }
          if (method !== 'eth_call') throw new Error(`the test reached the chain with ${method}`)
          const [call, block] = params as [{ to: Address; data: Hex }, unknown]
          state.readAt.push(block)
          if (state.readErrors > 0) {
            state.readErrors--
            throw new Error('429 Too Many Requests')
          }
          if (call.to.toLowerCase() !== LOCK) throw new Error(`a read of ${call.to}`)
          const { functionName } = decodeFunctionData({ abi: LOCK_ABI, data: call.data })
          if (functionName === 'token') {
            return encodeFunctionResult({
              abi: LOCK_ABI,
              functionName: 'token',
              result: TOKEN.token,
            })
          }
          if (functionName === 'commitment') {
            const past = block !== 'latest' && state.heldBefore !== undefined
            return encodeFunctionResult({
              abi: LOCK_ABI,
              functionName: 'commitment',
              result: lockRecord(past ? (state.heldBefore ?? null) : state.holds) as never,
            })
          }
          throw new Error(`a read of ${functionName}`)
        },
      },
      { retryCount: 0 },
    ),
  })
  return { state, client }
}

async function setup(options: Parameters<typeof bookingFixture>[0] = {}) {
  const f = await bookingFixture(options)
  const chain = lockChain()
  const sent: Call[][] = []
  const clock = { now: NOW }
  const sending = {
    /** What the lock holds after the transaction lands, the approval it carried by default. */
    holds: (approval: Approval): Approval | null => approval,
    fail: null as Error | null,
    /** Whether the lock holds the approval when the send fails anyway. */
    landsAnyway: false,
  }
  const send: NonNullable<AgentConfig['send']> = async (c) => {
    f.calls.push('send')
    sent.push(c)
    const last = f.approvals.at(-1)
    if (sending.fail) {
      if (sending.landsAnyway && last) chain.state.holds = last.message
      throw sending.fail
    }
    chain.state.holds = last ? sending.holds(last.message) : null
    return { transactionHash: id('the reserve transaction'), blockNumber: LANDED_IN }
  }
  const config: AgentConfig<typeof f.avow> = {
    client: chain.client,
    key: f.key,
    mandate: f.signedMandate,
    token: TOKEN,
    profile: TESTNET_DEMO_PROFILE,
    avow: f.avow,
    now: () => clock.now,
    send,
    limits: quick,
  }
  return { ...f, chain, sent, clock, sending, config, agent: createAgent(config) }
}

const book = (
  s: Awaited<ReturnType<typeof setup>>,
  change: Parameters<typeof gpuBooking>[0] = {},
) =>
  s.agent.book({
    supplier: s.connection,
    terms: gpuReservationTerms(gpuBooking(change)),
    category: 'compute',
  })

/** Version 3 terms relying on a booking in a lock that doesn't exist, typed as a booking's. */
const relyingOnAnother = () =>
  chainedTerms(gpuReservationTerms(gpuBooking()), [
    {
      on: {
        kind: 'commitment',
        chainId: 42431,
        lock: '0x000000000000000000000000000000000000dead',
        commitmentId: id('no such booking'),
        side: 'buyer',
        termsHash: id('no such terms'),
      },
      condition: 'accepted',
      disclosed: 'subject',
    },
  ]) as never

/** Books, and returns the commitment's id, with the lock holding its reserve. */
async function booked(s: Awaited<ReturnType<typeof setup>>): Promise<Hex> {
  const result = await book(s)
  if (!result.ok) throw new Error(result.reason)
  s.calls.length = 0
  return result.commitment.commitmentId
}

describe('booking with a supplier', () => {
  it('agrees the terms, has Avow approve, checks the approval and funds the reserve', async () => {
    const s = await setup()
    const result = await book(s)
    if (!result.ok) throw new Error(result.reason)
    expect(s.calls).toEqual(['signAgreement', 'approveReserve', 'send'])
    const c = result.commitment
    expect(c.termsHash).toBe(termsHash(c.terms, c.salt))
    expect(c.reservedIn).toBe(id('the reserve transaction'))

    // The agreement both sides signed names the commitment, both businesses and the mandate.
    const agreement = c.agreement
    expect(agreement.message).toMatchObject({
      commitmentId: c.commitmentId,
      termsHash: c.termsHash,
      category: 'compute',
      buyerBusinessId: 'biz_buyer',
      supplierBusinessId: 'biz_supplier',
      mandateHash: s.mHash,
      expiry: NOW + 600n,
    })
    const digest = digestOf(termsAgreementTypedData(agreement.message, D))
    const buyer = await recoverAddress({ hash: digest, signature: agreement.buyerSignature })
    expect(buyer.toLowerCase()).toBe(s.key.accessKeyAddress.toLowerCase())

    // Avow got the agreement, the salt and the request as the agent's key funds it.
    const [request] = s.requests
    expect(request).toMatchObject({ salt: c.salt, fundedBy: 'agent' })
    expect(request?.request).toMatchObject({
      commitmentId: c.commitmentId,
      agentKey: s.key.accessKeyAddress,
      supplier: 'biz_supplier',
      payee: s.supplier.payee,
    })

    // One transaction approves the lock to pull the reserve, then calls reserve with the approval.
    const [calls] = s.sent
    if (!calls) throw new Error('nothing was sent')
    const [approve, reserve] = calls
    expect(approve?.to).toBe(TOKEN.token)
    const [spender, amount] = decodeFunctionData({ abi: Abis.tip20, data: approve?.data ?? '0x' })
      .args as [Address, bigint]
    expect(spender.toLowerCase()).toBe(LOCK)
    expect(amount).toBe(500_000_000n)
    expect(reserve?.to).toBe(LOCK)
    expect(reserve?.data).toBe(
      encodeFunctionData({
        abi: RESERVE_ABI,
        functionName: 'reserve',
        args: [approvalTypedData(c.approval.message, D).message, c.approval.signature],
      }),
    )

    // It read the lock as of the block the reserve landed in, never an older one.
    expect(s.chain.state.readAt).toEqual(['0x7', '0x7'])
  })

  it('refuses terms that break their rules before asking anyone', async () => {
    const s = await setup()
    const production = createAgent({ ...s.config, profile: PRODUCTION_PROFILE })
    // A 10-minute contest window is the testnet profile's, and production refuses it.
    expect(
      await production.book({
        supplier: s.connection,
        terms: gpuReservationTerms(gpuBooking()),
        category: 'compute',
      }),
    ).toEqual({ ok: false, reason: 'terms.contest_window_short' })
    expect(s.calls).toEqual([])
  })

  it('books terms built outside the SDK, such as ones read from JSON, and carries them unchanged', async () => {
    const s = await setup()
    // Terms as another service would send them, read with the spec's own parser.
    const parsed = parseTerms(JSON.parse(JSON.stringify(toWire(gpuReservationTerms(gpuBooking())))))
    if (!parsed.ok) throw new Error(parsed.reason)
    const result = await s.agent.book({
      supplier: s.connection,
      terms: parsed.value,
      category: 'compute',
    })
    if (!result.ok) throw new Error(result.reason)
    expect(result.commitment.terms).toBe(parsed.value)
    expect(s.requests[0]?.request.terms).toBe(parsed.value)
    expect(result.commitment.termsHash).toBe(termsHash(parsed.value, result.commitment.salt))
  })

  it("refuses terms built outside the SDK that break their template's rules or aren't version 2, before asking anyone", async () => {
    const s = await setup()
    const terms = gpuReservationTerms(gpuBooking())
    const larger = { ...terms, backing: { ...terms.backing, amount: terms.backing.amount + 1n } }
    expect(
      await s.agent.book({ supplier: s.connection, terms: larger, category: 'compute' }),
    ).toEqual({ ok: false, reason: 'terms.reserve_mismatch' })
    // Version 1 terms stay readable for commitments made under them, and no new commitment takes them.
    const older = testnetDemoTermsV1(START, '0x000000000000000000000000000000000000a4b1')
    expect(
      await s.agent.book({ supplier: s.connection, terms: older as never, category: 'compute' }),
    ).toEqual({ ok: false, reason: 'terms.version_unknown' })
    expect(s.calls).toEqual([])
  })

  it('refuses a booking that relies on another before anything is signed or sent to Avow', async () => {
    // Until the agent checks the bookings it relies on, a version 3 booking never reaches its key,
    // the supplier or Avow, even one that names a lock that doesn't exist.
    const s = await setup()
    expect(
      await s.agent.book({
        supplier: s.connection,
        terms: relyingOnAnother(),
        category: 'compute',
      }),
    ).toEqual({ ok: false, reason: 'terms.version_unknown' })
    expect(s.calls).toEqual([])
    expect(s.sent).toEqual([])
  })

  it('refuses version 3 itself, before the mandate check runs', async () => {
    // With the mandate expired, the mandate check refuses a plain booking with its own reason, so
    // only the agent's own refusal gives this one.
    const s = await setup()
    s.clock.now = NOW + 86_400n
    expect(await book(s)).toEqual({ ok: false, reason: 'mandate.expired' })
    expect(
      await s.agent.book({
        supplier: s.connection,
        terms: relyingOnAnother(),
        category: 'compute',
      }),
    ).toEqual({ ok: false, reason: 'terms.version_unknown' })
    expect(s.calls).toEqual([])
    expect(s.sent).toEqual([])
  })

  it("refuses a booking the mandate doesn't allow before asking anyone, as Avow and the verifier do", async () => {
    const other = await setup()
    const elsewhere = await other.agent.book({
      supplier: { ...other.connection, profile: { ...other.supplier, businessId: 'biz_other' } },
      terms: gpuReservationTerms(gpuBooking()),
      category: 'compute',
    })
    expect(elsewhere).toEqual({ ok: false, reason: 'mandate.supplier_not_allowed' })

    const s = await setup()
    expect(
      await s.agent.book({
        supplier: s.connection,
        terms: gpuReservationTerms(gpuBooking()),
        category: 'storage',
      }),
    ).toEqual({ ok: false, reason: 'mandate.category_not_allowed' })
    const short = await setup({ mandate: { expiry: START + 60n } })
    expect(await book(short)).toEqual({ ok: false, reason: 'mandate.ends_before_window' })
    const capped = await setup({ mandate: { capPerCommitment: dollars(400) } })
    expect(await book(capped)).toEqual({ ok: false, reason: 'mandate.over_commitment_cap' })
    for (const x of [other, s, short, capped]) expect(x.calls).toEqual([])
  })

  it('refuses a reserve the mandate sends to the administrator, which it cannot carry yet', async () => {
    const s = await setup({ mandate: { approvalRule: { kind: 'always' } } })
    expect(await book(s)).toEqual({ ok: false, reason: 'approval.human_required' })
    expect(s.calls).toEqual([])
  })

  it("refuses to book when the mandate doesn't permit reserves", async () => {
    const s = await setup({ mandate: { actions: ['start'] } })
    expect(await book(s)).toEqual({ ok: false, reason: 'mandate.action_not_permitted' })
    expect(s.calls).toEqual([])
  })

  it('refuses a supplier signature from another key, before Avow sees the agreement', async () => {
    const s = await setup()
    s.hooks.signAgreementWith = privateKeyToAccount(generatePrivateKey())
    expect(await book(s)).toEqual({ ok: false, reason: 'message.signature_invalid' })
    expect(s.calls).toEqual(['signAgreement'])
  })

  it("passes on Avow's refusal with its decision, and sends nothing", async () => {
    const s = await setup()
    s.hooks.refusal = 'mandate.over_open_reserves_cap'
    expect(await book(s)).toEqual({
      ok: false,
      reason: 'mandate.over_open_reserves_cap',
      decisionId: 'dec_1',
    })
    expect(s.sent).toEqual([])
  })

  it('funds only an approval that says exactly what the terms and the mandate say', async () => {
    const other: Address = '0x000000000000000000000000000000000000dead'
    const cases: [Partial<Approval>, string][] = [
      [{ commitmentId: id('another commitment') }, 'approval.commitment_mismatch'],
      [{ supplier: other }, 'approval.parties_mismatch'],
      [{ supplierSigner: other }, 'approval.parties_mismatch'],
      [{ payee: other }, 'approval.parties_mismatch'],
      [{ token: '0x20c0000000000000000000000000000000000002' }, 'approval.terms_mismatch'],
      [{ side: 'supplier' }, 'approval.terms_mismatch'],
      [{ amount: 500_000_001n }, 'approval.terms_mismatch'],
      [{ releaseDate: START + 1801n }, 'approval.terms_mismatch'],
      [{ termsHash: id('other terms') }, 'approval.terms_mismatch'],
      [{ charges: [] }, 'approval.charges_mismatch'],
      [{ arbiter: other }, 'approval.dispute_mismatch'],
      [{ mandateHash: id('another mandate') }, 'approval.mandate_mismatch'],
      [{ capPerCommitment: 500_000_001n }, 'approval.mandate_mismatch'],
      [{ capOpenReserves: 1_500_000_001n }, 'approval.mandate_mismatch'],
      [{ fundingKey: other }, 'approval.mandate_mismatch'],
      [{ expiry: NOW }, 'message.expired'],
      [{ expiry: NOW + 301n }, 'message.validity_too_long'],
    ]
    for (const [change, reason] of cases) {
      const s = await setup()
      s.hooks.approvalChange = change
      expect(await book(s), JSON.stringify(Object.keys(change))).toEqual({
        ok: false,
        reason,
        decisionId: 'dec_1',
      })
      expect(s.sent).toEqual([])
    }
  })

  it('funds no approval the lock would refuse as past its acceptance deadline', async () => {
    const s = await setup()
    // Avow answers late, after the window opened, with an approval that hasn't itself expired.
    s.hooks.approvalChange = { expiry: START + 60n }
    s.hooks.afterApproval = () => {
      s.clock.now = START
    }
    expect(await book(s)).toEqual({
      ok: false,
      reason: 'authorization.accept_by_passed',
      decisionId: 'dec_1',
    })
    expect(s.sent).toEqual([])
  })

  it('funds only an approval signed for this chain and lock', async () => {
    const cases: [Partial<Signed<Approval>>, string][] = [
      [{ chainId: 1 }, 'message.wrong_chain'],
      [{ lock: '0x00000000000000000000000000000000000010c5' }, 'message.wrong_contract'],
      [{ schemaVersion: '9' }, 'message.schema_unknown'],
    ]
    for (const [change, reason] of cases) {
      const s = await setup()
      s.hooks.envelopeChange = change
      expect(await book(s)).toEqual({ ok: false, reason, decisionId: 'dec_1' })
      expect(s.sent).toEqual([])
    }
  })
})

describe('when funding the reserve goes wrong', () => {
  const sendError = (outcome: 'failed' | 'unknown', signings = 1) =>
    new SendError(`the send ended ${outcome}`, outcome, { hashes: [id('a hash')], signings })

  it('reads the lock once the approval stops working, and says no reserve was funded', async () => {
    for (const fail of [sendError('failed'), sendError('unknown'), new Error('socket hang up')]) {
      const s = await setup()
      s.sending.fail = fail
      const error = await book(s).catch((e: unknown) => e)
      if (!(error instanceof BookingError)) throw new Error('expected a BookingError')
      expect(error.outcome).toBe('failed')
      // It read the lock as of the finalized block, past the approval's expiry.
      expect(s.chain.state.readAt).toContain(toHex(LANDED_IN + 10n))
      const [request] = s.requests
      expect(error.commitment.commitmentId).toBe(request?.request.commitmentId)
      expect(error.commitment.salt).toBe(request?.salt)
      expect(error.commitment.approval.message.commitmentId).toBe(request?.request.commitmentId)
    }
  })

  it('carries every hash sent, and settles a send that failed before signing without reading', async () => {
    const s = await setup()
    s.sending.fail = sendError('failed', 0)
    const error = await book(s).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BookingError)
    expect((error as BookingError).outcome).toBe('failed')
    expect((error as BookingError).hashes).toEqual([id('a hash')])
    expect(s.chain.state.readAt).toEqual([])
  })

  it('returns the commitment when the reserve landed anyway, with the hash that funded it', async () => {
    const s = await setup()
    s.sending.fail = sendError('unknown')
    s.sending.landsAnyway = true
    s.chain.state.landed.add(id('a hash'))
    const result = await book(s)
    if (!result.ok) throw new Error(result.reason)
    expect(result.commitment.reservedIn).toBe(id('a hash'))

    // Landed in a transaction the agent never sent, such as the relay sending what it co-signed.
    const t = await setup()
    t.sending.fail = sendError('failed')
    t.sending.landsAnyway = true
    const other = await book(t)
    if (!other.ok) throw new Error(other.reason)
    expect(other.commitment.reservedIn).toBeNull()
  })

  it("says the outcome is unknown when the chain doesn't pass the approval's expiry in time", async () => {
    const s = await setup()
    s.sending.fail = sendError('unknown')
    s.chain.state.finalTime = NOW
    const error = await book(s).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BookingError)
    expect((error as BookingError).outcome).toBe('unknown')

    // Later the agent reconciles the same booking from the error, without booking again.
    const e = error as BookingError
    s.chain.state.finalTime = START
    expect(await s.agent.reconcile(e.commitment, e.hashes)).toEqual({ outcome: 'failed' })
    s.chain.state.holds = e.commitment.approval.message
    s.chain.state.landed.add(id('a hash'))
    expect(await s.agent.reconcile(e.commitment, e.hashes)).toEqual({
      outcome: 'funded',
      reservedIn: id('a hash'),
    })
    expect(s.calls.filter((c) => c === 'approveReserve')).toHaveLength(1)
  })

  it('never takes a failed read of the lock for an empty one', async () => {
    const s = await setup()
    s.sending.fail = sendError('unknown')
    s.sending.landsAnyway = true
    s.chain.state.readErrors = 3
    const result = await book(s)
    if (!result.ok) throw new Error(result.reason)
    expect(result.commitment.reservedIn).toBeNull()
  })

  it("waits for a finalized block at the approval's expiry, and reads the lock from that one", async () => {
    // Avow's approval in these tests expires 120 seconds after the clock's now.
    const s = await setup()
    s.sending.fail = sendError('failed')
    s.chain.state.finalTime = NOW + 119n
    const early = await book(s).catch((e: unknown) => e)
    expect((early as BookingError).outcome).toBe('unknown')
    s.chain.state.finalTime = NOW + 120n
    const e = early as BookingError
    expect(await s.agent.reconcile(e.commitment, e.hashes)).toEqual({ outcome: 'failed' })
  })

  it("says the outcome is unknown when the latest block doesn't agree the lock is empty", async () => {
    const s = await setup()
    s.sending.fail = sendError('failed')
    s.sending.landsAnyway = true
    s.chain.state.heldBefore = null
    const error = await book(s).catch((e: unknown) => e)
    expect((error as BookingError).outcome).toBe('unknown')
  })

  it("names only the agent's own transaction that succeeded on the lock as the one that funded it", async () => {
    const s = await setup()
    s.sending.fail = new SendError('the send ended unknown', 'unknown', {
      hashes: [id('reverted'), id('funded')],
      signings: 2,
    })
    s.sending.landsAnyway = true
    s.chain.state.reverted.add(id('reverted'))
    s.chain.state.landed.add(id('funded'))
    const result = await book(s)
    if (!result.ok) throw new Error(result.reason)
    expect(result.commitment.reservedIn).toBe(id('funded'))
  })

  it("settles a transaction that landed when the lock doesn't show the reserve under the approval", async () => {
    const s = await setup()
    s.sending.holds = () => null
    const error = await book(s).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BookingError)
    expect((error as BookingError).outcome).toBe('failed')
    expect((error as BookingError).hashes).toEqual([id('the reserve transaction')])

    // A lock holding the commitment under another approval isn't this booking funded.
    const t = await setup()
    t.sending.holds = (a) => ({ ...a, nonce: a.nonce + 1n })
    const other = await book(t).catch((e: unknown) => e)
    expect(other).toBeInstanceOf(BookingError)
    expect((other as BookingError).outcome).toBe('unknown')
  })
})

describe('cancelling and starting', () => {
  it('tells Avow the business cancels, when the mandate permits it', async () => {
    const s = await setup()
    expect(await s.agent.cancel(id('commitment'))).toEqual({ ok: true, cancelledAt: NOW + 60n })
    const reservesOnly = await setup({ mandate: { actions: ['reserve'] } })
    expect(await reservesOnly.agent.cancel(id('commitment'))).toEqual({
      ok: false,
      reason: 'mandate.action_not_permitted',
    })
    expect(reservesOnly.calls).toEqual([])
  })

  it('has Avow timestamp the request, the supplier sign its receipt and Avow record it, in order', async () => {
    const s = await setup()
    const id_ = await booked(s)
    const started = await s.agent.start(id_, s.connection)
    if (!started.ok) throw new Error(started.reason)
    expect(s.calls).toEqual(['requestStart', 'startJob', 'recordStart'])
    expect(started.receipt.message.startRequestHash).toBe(id(`start ${id_}`))
  })

  it("starts only a commitment the lock holds, with the connection's supplier", async () => {
    const s = await setup()
    expect(await s.agent.start(id('commitment'), s.connection)).toEqual({
      ok: false,
      reason: 'chain.reserve_missing',
    })
    const id_ = await booked(s)
    const stranger = privateKeyToAccount(generatePrivateKey())
    const elsewhere = { ...s.connection, profile: { ...s.supplier, signingKey: stranger.address } }
    expect(await s.agent.start(id_, elsewhere)).toEqual({
      ok: false,
      reason: 'chain.supplier_mismatch',
    })
    expect(s.calls).not.toContain('requestStart')
  })

  it("records no receipt that doesn't answer the request or isn't the supplier's", async () => {
    const stranger = privateKeyToAccount(generatePrivateKey())
    type Request = { commitmentId: Hex; startRequestHash: Hex; requestedAt: bigint }
    const cases: [(r: Request, key: typeof stranger) => Promise<Signed<never>>, string][] = [
      [(r) => startReceipt(stranger, r) as never, 'message.signature_invalid'],
      [(r, k) => startReceipt(k, r, { commitmentId: id('another') }) as never, 'message.invalid'],
      [(r, k) => startReceipt(k, r, { startRequestHash: id('other') }) as never, 'message.invalid'],
      [(r, k) => startReceipt(k, r, { startedAt: r.requestedAt - 1n }) as never, 'message.invalid'],
      [(r, k) => startReceipt(k, r, { side: 'supplier' }) as never, 'message.invalid'],
      [(r, k) => startReceipt(k, r, { expiry: NOW }) as never, 'message.expired'],
      [
        (r, k) =>
          startReceipt(k, r, {}, { lock: '0x00000000000000000000000000000000000010c5' }) as never,
        'message.wrong_contract',
      ],
    ]
    for (const [receipt, reason] of cases) {
      const s = await setup()
      const id_ = await booked(s)
      s.calls.length = 0
      s.hooks.receipt = (r) => receipt(r, s.supplierKey) as never
      expect(await s.agent.start(id_, s.connection)).toEqual({ ok: false, reason })
      expect(s.calls).toEqual(['requestStart', 'startJob'])
    }
  })

  it("passes on Avow's refusal of the receipt", async () => {
    const s = await setup()
    s.hooks.startRefusal = 'message.replayed'
    expect(await s.agent.start(await booked(s), s.connection)).toEqual({
      ok: false,
      reason: 'message.replayed',
    })
  })

  it("refuses to start when the mandate doesn't permit it", async () => {
    const s = await setup({ mandate: { actions: ['reserve'] } })
    expect(await s.agent.start(id('commitment'), s.connection)).toEqual({
      ok: false,
      reason: 'mandate.action_not_permitted',
    })
    expect(s.calls).toEqual([])
  })

  it('tells a JavaScript caller whose AvowApi lacks its records what is missing, and reads nothing', async () => {
    const s = await setup()
    const { approveReserve, sponsor, records } = s.avow
    // JavaScript checks no types, so its agent has cancel and start whatever AvowApi it passed.
    const untyped = (avow: object) => createAgent({ ...s.config, avow: avow as typeof s.avow })
    const none = untyped({ approveReserve, sponsor })
    await expect(none.cancel(id('commitment'))).rejects.toThrow(
      "The AvowApi this agent uses has no records, so it can't record a cancellation. httpAvowApi serves them.",
    )
    await expect(none.start(id('commitment'), s.connection)).rejects.toThrow(
      "has no records, so it can't start the job",
    )
    // The three calls loose beside the others, outside the group they belong to.
    const loose = untyped({ approveReserve, sponsor, ...records })
    await expect(loose.cancel(id('commitment'))).rejects.toThrow('has no records')
    const withoutRecord = { cancel: records.cancel, requestStart: records.requestStart }
    // @ts-expect-error An AvowApi serves all three records or none, so TypeScript refuses this.
    const partialApi: AvowApi = { approveReserve, sponsor, records: withoutRecord }
    // A partial group is refused when the agent is made, before any call could need it.
    expect(() => untyped(partialApi)).toThrow(
      "The AvowApi's records lack recordStart. An AvowApi serves all of Avow's record calls or none.",
    )
    expect(s.calls).toEqual([])
    expect(s.chain.state.readAt).toEqual([])
  })

  it("cancels through Avow's hosted API, signed by the agent's own key", async () => {
    const s = await setup()
    const sent: { url: string; authorization: string; body: Uint8Array }[] = []
    const avow = httpAvowApi({
      baseUrl: 'https://api.testnet.avow.finance',
      key: agentRequestKey(s.key),
      domain: D,
      fetch: (async (url: unknown, init: RequestInit = {}) => {
        const request = {
          url: String(url),
          authorization: new Headers(init.headers).get('authorization') ?? '',
          body: init.body as Uint8Array,
        }
        sent.push(request)
        const read = verifyApiRequest({
          audience: 'https://api.testnet.avow.finance',
          chainId: D.chainId,
          method: 'POST',
          path: new URL(request.url).pathname,
          body: request.body,
          authorization: request.authorization,
        })
        if (!read.ok) throw new Error(`the request doesn't verify: ${read.reason}`)
        const timestamp = {
          type: 'Timestamp',
          schemaVersion: '1',
          chainId: D.chainId,
          lock: D.verifyingContract,
          message: { requestHash: read.value.digest, receivedAt: '1800000000' },
          signature: `0x${'ab'.repeat(65)}`,
        }
        return new Response(JSON.stringify({ cancelledAt: '1800000000', timestamp }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }) as typeof fetch,
    })
    const agent = createAgent({ ...s.config, avow })
    expect(await agent.cancel(id('commitment'))).toEqual({ ok: true, cancelledAt: 1_800_000_000n })
    expect(sent.map((r) => new URL(r.url).pathname)).toEqual([
      `/v1/commitments/${id('commitment')}/cancellations`,
    ])
  })
})

describe('setting up an agent', () => {
  it('refuses a mandate for another key, another account or another chain, and a token it can’t use', async () => {
    const s = await setup()
    const strangerKey = Account.fromSecp256k1(generatePrivateKey(), { access: s.root })
    expect(() => createAgent({ ...s.config, key: strangerKey })).toThrow('another agent key')
    // The same key on another account has the same address, so only the account tells them apart.
    const elsewhere = Account.fromSecp256k1(s.agentKey, {
      access: Account.fromSecp256k1(generatePrivateKey()),
    })
    expect(() => createAgent({ ...s.config, key: elsewhere })).toThrow('another business account')
    expect(() => createAgent({ ...s.config, mandate: { ...s.signedMandate, chainId: 1 } })).toThrow(
      "can't be used on this chain",
    )
    expect(() => createAgent({ ...s.config, token: { ...TOKEN, chainId: 1 } })).toThrow(
      "isn't on the mandate's chain",
    )
    expect(() =>
      createAgent({ ...s.config, token: { ...TOKEN, currency: 'EUR' as never } }),
    ).toThrow('or in its currency')
  })
})
