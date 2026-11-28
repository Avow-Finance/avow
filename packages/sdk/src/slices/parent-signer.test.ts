import {
  type AuthorityLimits,
  dollars,
  enforceableTerms,
  gpuReservationTerms,
  type MandateChain,
  mandateChainProblem,
  newSalt,
  type Signed,
  type Slice,
  type SliceRevocation,
  TESTNET_DEMO_PROFILE,
  type TermsAgreement,
  termsHash,
  type WorkerSlices,
} from '@avow-finance/spec'
import { type Address, isAddressEqual } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Landed, Reconciled } from '../agent.js'
import { agentRequestKey } from '../http.js'
import type { Call } from '../lock.js'
import { SendError } from '../send.js'
import {
  type BookingFixture,
  bookingFixture,
  D,
  gpuBooking,
  id,
  NOW,
  TOKEN,
} from '../test/fixture.js'
import { handOutSlice, narrowSlice, revokeWorker, SliceRefused } from './hand-out.js'
import { createParentSigner } from './parent-signer.js'
import { signWorkerRequest, type WorkerAsk } from './worker-request.js'

let f: BookingFixture
let mandates: MandateChain
let served: Map<string, WorkerSlices>
let open: { mandate: bigint; slices: bigint[] }
let approved: bigint[]
let sent: Call[][]
/** Avow's approvals of reserves under the worker's slice, by commitment, in micros. */
let avowApproved: Map<string, bigint>
let sendImpl: (calls: Call[]) => Promise<Landed>
let reconcileImpl: () => Promise<Reconciled>
let inHoldings: number
let mostAtOnce: number
const worker = privateKeyToAccount(generatePrivateKey())

const limits = (change: Partial<AuthorityLimits> = {}): AuthorityLimits => ({
  actions: ['reserve'],
  currency: 'USD',
  capPerCommitment: dollars(400),
  capOpenReserves: dollars(800),
  suppliers: ['biz_supplier'],
  categories: ['compute'],
  paymentLimits: [{ token: TOKEN.token, amount: dollars(800), period: 86_400n }],
  approvalRule: { kind: 'above', amount: dollars(800) },
  expiry: NOW + 3_600n * 12n,
  ...change,
})

function signer() {
  return createParentSigner({
    key: f.key,
    domain: D,
    token: TOKEN,
    profile: TESTNET_DEMO_PROFILE,
    now: () => NOW,
    mandates: async () => mandates,
    workerSlices: async (k: Address) => served.get(k.toLowerCase()) ?? null,
    // As Avow counts them: what it approved under the slice, less the commitment left out.
    holdings: async (chain, excluding) => {
      inHoldings++
      mostAtOnce = Math.max(mostAtOnce, inHoldings)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inHoldings--
      let counted = 0n
      for (const [commitment, micros] of avowApproved) {
        if (commitment !== excluding?.toLowerCase()) counted += micros
      }
      return {
        openReserves: {
          mandate: open.mandate + counted,
          slices: chain.levels.map((_, i) => (open.slices[i] ?? 0n) + counted),
        },
        approvedWithin: chain.levels.map((_, i) => (approved[i] ?? 0n) + counted),
      }
    },
    send: (calls) => {
      sent.push(calls)
      return sendImpl(calls)
    },
    reconcile: () => reconcileImpl(),
  })
}

async function give(change: Partial<AuthorityLimits> = {}): Promise<Signed<Slice>> {
  const slice = await handOutSlice({
    issuer: agentRequestKey(f.key),
    domain: D,
    mandate: { message: f.mandate, hash: f.mHash },
    parent: null,
    subKey: worker.address,
    limits: limits(change),
  })
  served.set(worker.address.toLowerCase(), {
    levels: [{ current: slice, earlier: [] }],
    revocations: [],
  })
  return slice
}

/** What a worker asks to commit to: a GPU booking with a $500 reserve. */
function agreementAsk(
  change: Partial<TermsAgreement> = {},
): Extract<WorkerAsk, { kind: 'agreement' }> {
  const terms = gpuReservationTerms(
    gpuBooking({ noShow: dollars(300), lateCancellation: dollars(100) }),
  )
  const salt = newSalt()
  const commitmentId = id(`commitment ${salt}`)
  return {
    kind: 'agreement',
    salt,
    request: {
      commitmentId,
      agentKey: f.key.accessKeyAddress,
      supplier: 'biz_supplier',
      payee: f.supplier.payee,
      category: 'compute',
      terms,
    },
    agreement: {
      commitmentId,
      termsHash: termsHash(terms, salt),
      category: 'compute',
      buyerBusinessId: f.mandate.businessId,
      supplierBusinessId: 'biz_supplier',
      mandateHash: f.mHash,
      nonce: 1n,
      expiry: NOW + 600n,
      ...change,
    },
  }
}

const asked = (ask: WorkerAsk, key = worker) => signWorkerRequest(ask, key, NOW)

/** Avow's approval of the reserve an agreement asks for, which Avow then counts as held. */
async function approve(ask: Extract<WorkerAsk, { kind: 'agreement' }>) {
  const answer = await f.avow.approveReserve({
    request: ask.request,
    salt: ask.salt,
    agreement: {} as never,
    fundedBy: 'agent',
  })
  if (!answer.ok) throw new Error('not approved')
  avowApproved.set(
    ask.request.commitmentId.toLowerCase(),
    enforceableTerms(ask.request.terms).reserve,
  )
  return answer.approval
}

const reserveOf = (ask: Extract<WorkerAsk, { kind: 'agreement' }>) =>
  enforceableTerms(ask.request.terms).reserve

beforeEach(async () => {
  f = await bookingFixture()
  const read = mandateChainProblem(
    { current: f.signedMandate, earlier: [] },
    { domain: D, agentKey: f.key.accessKeyAddress, witness: f.mHash },
  )
  if (!read.ok) throw new Error(read.reason)
  mandates = read.value
  served = new Map()
  open = { mandate: 0n, slices: [] }
  approved = []
  sent = []
  avowApproved = new Map()
  sendImpl = async () => ({ transactionHash: id('funded'), blockNumber: 7n })
  reconcileImpl = async () => ({ outcome: 'unknown' })
  inHoldings = 0
  mostAtOnce = 0
})

describe('handing out a slice', () => {
  it('signs a slice of the mandate with the agent key', async () => {
    const slice = await give()
    expect(slice.message.issuerKey).toBe(f.key.accessKeyAddress)
    expect(slice.message.mandateHash).toBe(f.mHash)
  })

  it('refuses limits wider than the mandate, before signing', async () => {
    await expect(give({ capPerCommitment: dollars(501) })).rejects.toThrow(SliceRefused)
    await expect(give({ suppliers: [] })).rejects.toThrow(SliceRefused)
  })

  it('narrows a slice only', async () => {
    const slice = await give()
    const narrower = await narrowSlice({
      issuer: agentRequestKey(f.key),
      domain: D,
      current: slice.message,
      limits: limits({ capOpenReserves: dollars(500) }),
    })
    expect(narrower.message.replaces).toBeDefined()
    await expect(
      narrowSlice({
        issuer: agentRequestKey(f.key),
        domain: D,
        current: slice.message,
        limits: limits({ capOpenReserves: dollars(900) }),
      }),
    ).rejects.toThrow(SliceRefused)
  })
})

describe("the agent's signer for its workers", () => {
  it('signs an agreement within the slice, then funds the approval Avow gives for it', async () => {
    await give()
    const s = signer()
    const ask = agreementAsk()
    const signed = await s.handle(await asked(ask))
    expect(signed).toMatchObject({ ok: true, kind: 'agreement' })

    const answer = await f.avow.approveReserve({
      request: ask.request,
      salt: ask.salt,
      agreement: {} as never,
      fundedBy: 'agent',
    })
    if (!answer.ok) throw new Error('not approved')
    const funded = await s.handle(await asked({ kind: 'fund', approval: answer.approval }))
    expect(funded).toEqual({
      ok: true,
      kind: 'fund',
      transactionHash: id('funded'),
      blockNumber: 7n,
    })
    expect(sent).toHaveLength(1)
  })

  it("refuses a request the worker's key didn't sign, one replayed, or one that lives too long", async () => {
    await give()
    const s = signer()
    const request = await asked(agreementAsk())
    expect(
      await s.handle({ ...request, signature: (await asked(agreementAsk())).signature }),
    ).toEqual({
      ok: false,
      reason: 'message.signature_invalid',
    })
    expect((await s.handle(request)).ok).toBe(true)
    expect(await s.handle(request)).toEqual({ ok: false, reason: 'message.replayed' })
    const long = await signWorkerRequest(agreementAsk(), worker, NOW, 3_600n)
    expect(await s.handle(long)).toEqual({ ok: false, reason: 'message.validity_too_long' })
  })

  it('refuses a key with no slice, and one whose slice was revoked', async () => {
    const s = signer()
    expect(await s.handle(await asked(agreementAsk()))).toEqual({
      ok: false,
      reason: 'slice.key_mismatch',
    })
    await give()
    const revocation: Signed<SliceRevocation> = await revokeWorker({
      by: agentRequestKey(f.key),
      domain: D,
      mandate: f.mandate,
      subKey: worker.address,
    })
    const held = served.get(worker.address.toLowerCase()) as WorkerSlices
    served.set(worker.address.toLowerCase(), { ...held, revocations: [revocation] })
    expect(await s.handle(await asked(agreementAsk()))).toEqual({
      ok: false,
      reason: 'slice.revoked',
    })
  })

  it('refuses a booking the slice does not allow, and one its siblings leave no room for', async () => {
    await give({ capPerCommitment: dollars(1) })
    expect(await signer().handle(await asked(agreementAsk()))).toEqual({
      ok: false,
      reason: 'mandate.over_commitment_cap',
    })
    await give()
    open = { mandate: dollars(1500), slices: [0n] }
    expect(await signer().handle(await asked(agreementAsk()))).toEqual({
      ok: false,
      reason: 'mandate.over_open_reserves_cap',
    })
  })

  it("funds a reserve that takes most of the room left, counting Avow's approval of it once", async () => {
    const ask = agreementAsk()
    // Room for one and a half of these reserves, so counting it twice would refuse it.
    await give({ capOpenReserves: (reserveOf(ask) * 3n) / 2n, capPerCommitment: reserveOf(ask) })
    const s = signer()
    expect((await s.handle(await asked(ask))).ok).toBe(true)
    const approval = await approve(ask)
    expect(await s.handle(await asked({ kind: 'fund', approval }))).toMatchObject({
      ok: true,
      kind: 'fund',
    })
  })

  it('funds one commitment once, however many times it is asked at once', async () => {
    await give()
    const s = signer()
    const ask = agreementAsk()
    expect((await s.handle(await asked(ask))).ok).toBe(true)
    const approval = await approve(ask)
    const answers = await Promise.all([
      s.handle(await asked({ kind: 'fund', approval })),
      s.handle(await asked({ kind: 'fund', approval })),
    ])
    expect(answers.every((a) => a.ok)).toBe(true)
    expect(sent).toHaveLength(1)
    // Asked again later, it answers the same and sends nothing.
    expect(await s.handle(await asked({ kind: 'fund', approval }))).toEqual(answers[0])
    expect(sent).toHaveLength(1)
  })

  it('checks one ask at a time', async () => {
    await give()
    const s = signer()
    await Promise.all([1, 2, 3].map(async () => s.handle(await asked(agreementAsk()))))
    expect(mostAtOnce).toBe(1)
  })

  it('reconciles a send that failed after signing, and keeps the agreement until it knows', async () => {
    await give()
    const s = signer()
    const ask = agreementAsk()
    expect((await s.handle(await asked(ask))).ok).toBe(true)
    const approval = await approve(ask)
    sendImpl = async () => {
      throw new SendError('no receipt', 'unknown', { hashes: [id('maybe')], signings: 1 })
    }
    expect(await s.handle(await asked({ kind: 'fund', approval }))).toEqual({
      ok: false,
      reason: 'service.unavailable',
    })
    reconcileImpl = async () => ({ outcome: 'funded', reservedIn: id('maybe') })
    expect(await s.handle(await asked({ kind: 'fund', approval }))).toEqual({
      ok: true,
      kind: 'fund',
      transactionHash: id('maybe'),
      blockNumber: null,
    })
    expect(await s.handle(await asked({ kind: 'fund', approval }))).toMatchObject({ ok: true })
  })

  it('sends again when the first send never signed, and spends an approval that can no longer land', async () => {
    await give()
    const s = signer()
    const ask = agreementAsk()
    expect((await s.handle(await asked(ask))).ok).toBe(true)
    const approval = await approve(ask)
    sendImpl = async () => {
      throw new SendError('node down', 'failed', { hashes: [], signings: 0 })
    }
    expect((await s.handle(await asked({ kind: 'fund', approval }))).ok).toBe(false)
    sendImpl = async () => {
      throw new SendError('reverted', 'failed', { hashes: [id('reverted')], signings: 1 })
    }
    reconcileImpl = async () => ({ outcome: 'failed' })
    expect(await s.handle(await asked({ kind: 'fund', approval }))).toEqual({
      ok: false,
      reason: 'message.expired',
    })
    expect(sent).toHaveLength(2)
  })

  it('refuses an agreement open longer than an offer may stay open', async () => {
    await give()
    expect(await signer().handle(await asked(agreementAsk({ expiry: NOW + 601n })))).toEqual({
      ok: false,
      reason: 'message.validity_too_long',
    })
  })

  it("refuses a booking past the slice's payment limit for the period", async () => {
    await give()
    approved = [dollars(800)]
    expect(await signer().handle(await asked(agreementAsk()))).toEqual({
      ok: false,
      reason: 'mandate.over_payment_limit',
    })
  })

  it('refuses an agreement under another mandate, for other terms, or for another key', async () => {
    await give()
    const s = signer()
    expect((await s.handle(await asked(agreementAsk({ mandateHash: id('other') })))).ok).toBe(false)
    expect(await s.handle(await asked(agreementAsk({ termsHash: id('other terms') })))).toEqual({
      ok: false,
      reason: 'terms.hash_mismatch',
    })
    const ask = agreementAsk()
    const other = { ...ask, request: { ...ask.request, agentKey: worker.address } }
    expect(await s.handle(await asked(other))).toEqual({ ok: false, reason: 'agent.key_mismatch' })
  })

  it('funds only an approval for an agreement it signed for that same worker', async () => {
    await give()
    const s = signer()
    const ask = agreementAsk()
    const answer = await f.avow.approveReserve({
      request: ask.request,
      salt: ask.salt,
      agreement: {} as never,
      fundedBy: 'agent',
    })
    if (!answer.ok) throw new Error('not approved')
    expect(await s.handle(await asked({ kind: 'fund', approval: answer.approval }))).toEqual({
      ok: false,
      reason: 'approval.commitment_mismatch',
    })

    expect((await s.handle(await asked(ask))).ok).toBe(true)
    const sibling = privateKeyToAccount(generatePrivateKey())
    served.set(
      sibling.address.toLowerCase(),
      served.get(worker.address.toLowerCase()) as WorkerSlices,
    )
    expect(
      await s.handle(await asked({ kind: 'fund', approval: answer.approval }, sibling)),
    ).toMatchObject({ ok: false })

    f.hooks.approvalChange = { fundingKey: worker.address }
    const otherFunder = await f.avow.approveReserve({
      request: ask.request,
      salt: ask.salt,
      agreement: {} as never,
      fundedBy: 'agent',
    })
    if (!otherFunder.ok) throw new Error('not approved')
    expect(await s.handle(await asked({ kind: 'fund', approval: otherFunder.approval }))).toEqual({
      ok: false,
      reason: 'approval.mandate_mismatch',
    })
    expect(sent).toHaveLength(0)
  })

  it('reads the slice again before funding, so a worker revoked after agreeing funds nothing', async () => {
    await give()
    const s = signer()
    const ask = agreementAsk()
    expect((await s.handle(await asked(ask))).ok).toBe(true)
    served.delete(worker.address.toLowerCase())
    const answer = await f.avow.approveReserve({
      request: ask.request,
      salt: ask.salt,
      agreement: {} as never,
      fundedBy: 'agent',
    })
    if (!answer.ok) throw new Error('not approved')
    expect(await s.handle(await asked({ kind: 'fund', approval: answer.approval }))).toEqual({
      ok: false,
      reason: 'slice.key_mismatch',
    })
    expect(sent).toHaveLength(0)
    expect(isAddressEqual(answer.approval.message.fundingKey, f.key.accessKeyAddress)).toBe(true)
  })
})
