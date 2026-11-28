import type { Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import { dollars } from './demo.js'
import { digestOf, mandateHash, mandateVersion } from './eip712.js'
import { mandateChainProblem } from './mandate-chain.js'
import { TESTNET_DEMO_PROFILE } from './profiles.js'
import { type Slice, sliceTypedData } from './slice.js'
import { type SliceChain, sliceChainProblem } from './slice-chain.js'
import { checkSlicedMandate, type SlicedCheckInput } from './slice-check.js'
import {
  CHAIN_ID,
  DOMAIN,
  demoMandate,
  demoRequest,
  demoSlice,
  id,
  LOCK,
  NOW,
  newKey,
  TOKEN,
} from './test-helpers.js'
import type { Mandate } from './types.js'

const admin = newKey()
const agent = newKey()
const worker = newKey()
const grandchild = newKey()

const proof = (m: Mandate) => ({
  type: 'Mandate' as const,
  schemaVersion: mandateVersion(m),
  chainId: CHAIN_ID,
  lock: LOCK,
  message: m,
  signature: `0x${'11'.repeat(65)}` as Hex,
})

async function chainOf(mandate: Mandate, slices: Slice[], earlier?: Mandate): Promise<SliceChain> {
  const read = mandateChainProblem(
    { current: proof(mandate), earlier: earlier ? [proof(earlier)] : [] },
    {
      domain: DOMAIN,
      agentKey: agent.address,
      witness: mandateHash(earlier ?? mandate, DOMAIN),
    },
  )
  if (!read.ok) throw new Error(read.reason)
  const signers = [agent, worker, grandchild]
  const levels = await Promise.all(
    slices.map(async (s, i) => ({
      current: {
        type: 'Slice' as const,
        schemaVersion: '1',
        chainId: CHAIN_ID,
        lock: LOCK,
        message: s,
        signature: await (signers[i] as typeof agent).sign({
          hash: digestOf(sliceTypedData(s, DOMAIN)),
        }),
      },
      earlier: [],
    })),
  )
  const last = slices[slices.length - 1] as Slice
  const chain = await sliceChainProblem(
    { levels, revocations: [] },
    { domain: DOMAIN, mandates: read.value, subKey: last.subKey },
  )
  if (!chain.ok) throw new Error(chain.reason)
  return chain.value
}

const mandate = demoMandate(admin.address, agent.address)
const top = demoSlice(mandate, mandateHash(mandate, DOMAIN), worker.address)
const below: Slice = {
  ...top,
  sliceId: id('below'),
  parentSliceId: top.sliceId,
  issuerKey: worker.address,
  subKey: grandchild.address,
  by: worker.address,
  capOpenReserves: dollars(700),
}

async function input(
  slices: Slice[] = [top],
  open: SlicedCheckInput['openReserves'] = { mandate: 0n, slices: slices.map(() => 0n) },
  m: Mandate = mandate,
): Promise<SlicedCheckInput> {
  return {
    chain: await chainOf(m, slices),
    request: demoRequest(agent.address),
    token: TOKEN,
    openReserves: open,
    approvedWithin: slices.map(() => 0n),
    revoked: false,
    now: NOW,
    profile: TESTNET_DEMO_PROFILE,
  }
}

describe('checkSlicedMandate', () => {
  it('approves a reserve every level lets through', async () => {
    expect(checkSlicedMandate(await input())).toEqual({
      result: 'approved',
      reason: 'approved',
      level: 0,
    })
    expect(checkSlicedMandate(await input([top, below])).result).toBe('approved')
  })

  it("refuses at the slice a reserve its own limits don't allow, naming the level", async () => {
    const tight = { ...top, capPerCommitment: dollars(499) }
    expect(checkSlicedMandate(await input([tight]))).toEqual({
      result: 'denied',
      reason: 'mandate.over_commitment_cap',
      level: 1,
    })
    const smaller = { ...below, capPerCommitment: dollars(499) }
    expect(checkSlicedMandate(await input([top, smaller]))).toMatchObject({
      reason: 'mandate.over_commitment_cap',
      level: 2,
    })
  })

  it('counts what is open under each level, so slices together never pass their parent', async () => {
    // The worker's own slice has room, and the mandate, holding every worker's reserves, has none.
    expect(
      checkSlicedMandate(await input([top], { mandate: dollars(1501), slices: [0n] })),
    ).toMatchObject({ result: 'denied', reason: 'mandate.over_open_reserves_cap', level: 0 })
    // The grandchild's slice has room, and its parent, holding its siblings too, has none.
    expect(
      checkSlicedMandate(
        await input([top, below], { mandate: dollars(701), slices: [dollars(701), 0n] }),
      ),
    ).toMatchObject({ result: 'denied', reason: 'mandate.over_open_reserves_cap', level: 1 })
  })

  it("totals a slice's payment limit over its period, at the level it belongs to", async () => {
    // $3,000 a day for the worker's slice, and a $500 reserve.
    const room = { ...(await input()), approvedWithin: [dollars(2500)] }
    expect(checkSlicedMandate(room).result).toBe('approved')
    const full = { ...(await input()), approvedWithin: [dollars(2501)] }
    expect(checkSlicedMandate(full)).toEqual({
      result: 'denied',
      reason: 'mandate.over_payment_limit',
      level: 1,
    })
    const tight = {
      ...below,
      paymentLimits: [{ token: TOKEN.token, amount: dollars(600), period: 86_400n }],
    }
    const below2 = { ...(await input([top, tight])), approvedWithin: [0n, dollars(101)] }
    expect(checkSlicedMandate(below2)).toMatchObject({
      reason: 'mandate.over_payment_limit',
      level: 2,
    })
  })

  it("holds a worker to the slice's price limit and to the mandate's", async () => {
    const priced = { ...top, priceCapPerCommitment: 1n }
    expect(checkSlicedMandate(await input([priced]))).toMatchObject({
      reason: 'mandate.over_price_limit',
      level: 1,
    })
    const pricedMandate = { ...mandate, priceCapPerCommitment: 1n }
    const slice = {
      ...demoSlice(pricedMandate, mandateHash(pricedMandate, DOMAIN), worker.address),
      priceCapPerCommitment: 1n,
    }
    expect(checkSlicedMandate(await input([slice], undefined, pricedMandate))).toMatchObject({
      reason: 'mandate.over_price_limit',
      level: 0,
    })
  })

  it('holds a slice to a mandate narrowed after it was handed out', async () => {
    const narrowed = {
      ...mandate,
      suppliers: ['biz_other'],
      nonce: 2n,
      replaces: mandateHash(mandate, DOMAIN),
    }
    const chain = await chainOf(narrowed, [top], mandate)
    const read = { ...(await input()), chain }
    expect(checkSlicedMandate(read)).toMatchObject({
      reason: 'mandate.supplier_not_allowed',
      level: 0,
    })
  })

  it('sends a reserve to a person when a slice asks, and refuses before it when a level below refuses', async () => {
    const asks = { ...top, approvalRule: { kind: 'always' as const } }
    expect(checkSlicedMandate(await input([asks]))).toEqual({
      result: 'needs_human',
      reason: 'approval.human_required',
      level: 1,
    })
    const refuses = { ...below, approvalRule: { kind: 'always' as const }, expiry: NOW }
    expect(checkSlicedMandate(await input([asks, refuses]))).toMatchObject({
      result: 'denied',
      reason: 'mandate.expired',
      level: 2,
    })
  })

  it('needs what is open under every level', async () => {
    const short = await input([top, below], { mandate: 0n, slices: [0n] })
    expect(() => checkSlicedMandate(short)).toThrow(RangeError)
    const unapproved = { ...(await input([top, below])), approvedWithin: [0n] }
    expect(() => checkSlicedMandate(unapproved)).toThrow(RangeError)
  })
})
