import {
  type Approval,
  approvalTypedData,
  digestOf,
  dollars,
  PRODUCTION_PROFILE,
  type Signed,
  TESTNET_DEMO_PROFILE,
  termsAgreementTypedData,
  termsHash,
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
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { Abis, Account } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import { type AgentConfig, BookingError, createAgent } from './agent.js'
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

/**
 * A chain that answers only reads of the lock, with what it holds once the agent's reserve
 * landed. It records the block every read named.
 */
function lockChain() {
  const state = { holds: null as Approval | null, readAt: [] as unknown[] }
  const client = createClient({
    chain: tempoModerato,
    transport: custom({
      async request({ method, params }) {
        if (method !== 'eth_call') throw new Error(`the test reached the chain with ${method}`)
        const [call, block] = params as [{ to: Address; data: Hex }, unknown]
        state.readAt.push(block)
        if (call.to.toLowerCase() !== LOCK) throw new Error(`a read of ${call.to}`)
        const { functionName } = decodeFunctionData({ abi: LOCK_ABI, data: call.data })
        if (functionName === 'token') {
          return encodeFunctionResult({ abi: LOCK_ABI, functionName: 'token', result: TOKEN.token })
        }
        if (functionName === 'commitment') {
          return encodeFunctionResult({
            abi: LOCK_ABI,
            functionName: 'commitment',
            result: lockRecord(state.holds) as never,
          })
        }
        throw new Error(`a read of ${functionName}`)
      },
    }),
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
  }
  const send: NonNullable<AgentConfig['send']> = async (c) => {
    f.calls.push('send')
    sent.push(c)
    if (sending.fail) throw sending.fail
    const last = f.approvals.at(-1)
    chain.state.holds = last ? sending.holds(last.message) : null
    return { transactionHash: id('the reserve transaction'), blockNumber: LANDED_IN }
  }
  const config: AgentConfig = {
    client: chain.client,
    key: f.key,
    mandate: f.signedMandate,
    token: TOKEN,
    profile: TESTNET_DEMO_PROFILE,
    avow: f.avow,
    now: () => clock.now,
    send,
  }
  return { ...f, chain, sent, clock, sending, config, agent: createAgent(config) }
}

const book = (
  s: Awaited<ReturnType<typeof setup>>,
  change: Parameters<typeof gpuBooking>[0] = {},
) => s.agent.book({ supplier: s.connection, booking: gpuBooking(change), category: 'compute' })

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
      await production.book({ supplier: s.connection, booking: gpuBooking(), category: 'compute' }),
    ).toEqual({ ok: false, reason: 'terms.contest_window_short' })
    expect(s.calls).toEqual([])
  })

  it("refuses a booking the mandate doesn't allow before asking anyone, as Avow and the verifier do", async () => {
    const other = await setup()
    const elsewhere = await other.agent.book({
      supplier: { ...other.connection, profile: { ...other.supplier, businessId: 'biz_other' } },
      booking: gpuBooking(),
      category: 'compute',
    })
    expect(elsewhere).toEqual({ ok: false, reason: 'mandate.supplier_not_allowed' })

    const s = await setup()
    expect(
      await s.agent.book({ supplier: s.connection, booking: gpuBooking(), category: 'storage' }),
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
  it('throws with the commitment and the hashes sent, and says no reserve was funded', async () => {
    const s = await setup()
    s.sending.fail = new SendError('The transaction reverted', 'failed', [id('a hash')])
    const error = await book(s).catch((e: unknown) => e)
    if (!(error instanceof BookingError)) throw new Error('expected a BookingError')
    expect(error.outcome).toBe('failed')
    expect(error.hashes).toEqual([id('a hash')])
    const [request] = s.requests
    expect(error.commitment.commitmentId).toBe(request?.request.commitmentId)
    expect(error.commitment.salt).toBe(request?.salt)
    expect(error.commitment.approval.message.commitmentId).toBe(request?.request.commitmentId)
  })

  it("says the outcome is unknown when the send can't tell, or fails some other way", async () => {
    for (const fail of [
      new SendError('No receipt after waiting', 'unknown', [id('a hash')]),
      new Error('socket hang up'),
    ]) {
      const s = await setup()
      s.sending.fail = fail
      const error = await book(s).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(BookingError)
      expect((error as BookingError).outcome).toBe('unknown')
    }
  })

  it("throws when the transaction landed but the lock doesn't hold the reserve under the approval", async () => {
    const s = await setup()
    s.sending.holds = () => null
    await expect(book(s)).rejects.toThrow("the lock doesn't show the reserve")
    const t = await setup()
    t.sending.holds = (a) => ({ ...a, nonce: a.nonce + 1n })
    const error = await book(t).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BookingError)
    expect((error as BookingError).outcome).toBe('unknown')
    expect((error as BookingError).hashes).toEqual([id('the reserve transaction')])
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
    const started = await s.agent.start(id('commitment'), s.connection)
    if (!started.ok) throw new Error(started.reason)
    expect(s.calls).toEqual(['requestStart', 'startJob', 'recordStart'])
    expect(started.receipt.message.startRequestHash).toBe(id(`start ${id('commitment')}`))
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
      s.hooks.receipt = (r) => receipt(r, s.supplierKey) as never
      expect(await s.agent.start(id('commitment'), s.connection)).toEqual({ ok: false, reason })
      expect(s.calls).toEqual(['requestStart', 'startJob'])
    }
  })

  it("passes on Avow's refusal of the receipt", async () => {
    const s = await setup()
    s.hooks.startRefusal = 'message.replayed'
    expect(await s.agent.start(id('commitment'), s.connection)).toEqual({
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
