import {
  type AvowDomain,
  dollars,
  type Mandate,
  mandateHash,
  parseMandate,
  verifyApiRequest,
} from '@avow-finance/spec'
import type { Hex } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { Account } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import { AvowApiError, agentRequestKey } from '../http.js'
import { askForLateCharge, lateChargePath, parseLateChargeReport } from './late-charge.js'

// The keys are generated for the run and held only in memory.
const account = Account.fromSecp256k1(generatePrivateKey())
const agentKey = Account.fromSecp256k1(generatePrivateKey(), { access: account.address })
const domain: AvowDomain = {
  chainId: 42431,
  verifyingContract: '0x00000000000000000000000000000000000010c4',
}
const SUPPLIER = 'https://supplier.testnet.avow.finance'
const ID = `0x${'c1'.repeat(32)}` as Hex
const done = {
  commitmentId: ID,
  kind: 'lateCancellation',
  amount: '5000000',
  reportNumber: 1,
  transaction: `0x${'ab'.repeat(32)}`,
  outcome: 'awaiting_avow',
  buyer: { label: 'sandbox' },
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function fakeSupplier(answers: Response[]) {
  const seen: { url: string; authorization: string; body: Uint8Array }[] = []
  const fetcher = (async (url: string | URL | Request, init: RequestInit = {}) => {
    seen.push({
      url: String(url),
      authorization: new Headers(init.headers).get('authorization') ?? '',
      body: init.body as Uint8Array,
    })
    const next = answers.shift()
    if (!next) throw new Error('no more answers')
    return next
  }) as typeof fetch
  return { seen, fetcher }
}

const mandate: Mandate = {
  mandateId: `0x${'0d'.repeat(32)}`,
  businessId: 'sandbox-buyer',
  agentId: 'agt_1',
  account: account.address,
  agentKey: agentKey.accessKeyAddress,
  actions: ['reserve', 'cancel', 'start'],
  currency: 'USD',
  capPerCommitment: dollars(100),
  capOpenReserves: dollars(500),
  suppliers: ['avow-demo-gpu'],
  categories: ['compute'],
  paymentLimits: [
    { token: '0x20c00000000000000000000058fbF8a39A171185', amount: dollars(1000), period: 86_400n },
  ],
  approvalRule: { kind: 'never' },
  expiry: 1_800_086_400n,
  nonce: 1n,
}

const ask = (fetcher: typeof fetch) =>
  askForLateCharge({
    supplierUrl: `${SUPPLIER}/`,
    key: agentRequestKey(agentKey),
    domain,
    commitmentId: ID,
    mandate,
    fetch: fetcher,
    now: () => 1_800_000_000n,
    retryWait: 0,
  })

describe('askForLateCharge', () => {
  it("asks the supplier about the booking, signed by the agent's key with the booking's mandate", async () => {
    const { seen, fetcher } = fakeSupplier([json(200, done)])
    const report = await ask(fetcher)
    expect(report).toEqual({
      commitmentId: ID,
      amount: 5_000_000n,
      transaction: done.transaction,
      outcome: 'awaiting_avow',
    })
    expect(seen[0]?.url).toBe(`${SUPPLIER}${lateChargePath(ID)}`)
    const body = JSON.parse(new TextDecoder().decode(seen[0]?.body))
    expect(mandateHash(parseMandate(body.mandate), domain)).toBe(mandateHash(mandate, domain))
    const verified = verifyApiRequest({
      authorization: seen[0]?.authorization ?? '',
      method: 'POST',
      path: lateChargePath(ID),
      body: seen[0]?.body ?? new Uint8Array(),
      audience: SUPPLIER,
      chainId: domain.chainId,
    })
    expect(verified.ok && verified.value.credentials.lock).toBe(domain.verifyingContract)
    expect(verified.ok && verified.value.credentials.signer.toLowerCase()).toBe(
      agentKey.accessKeyAddress.toLowerCase(),
    )
  })

  it('sends the same request again while the report is on its way to the lock', async () => {
    const working = json(409, {
      error: { reason: 'request.in_progress', message: 'The report is on its way to the lock' },
    })
    const { seen, fetcher } = fakeSupplier([working, json(200, done)])
    await ask(fetcher)
    expect(seen).toHaveLength(2)
    expect(seen[1]?.authorization).toBe(seen[0]?.authorization)
  })

  it("throws the supplier's reason when it refuses", async () => {
    const { fetcher } = fakeSupplier([
      json(422, { error: { reason: 'report.too_early', message: 'Too early' } }),
    ])
    const error = await ask(fetcher).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AvowApiError)
    expect((error as AvowApiError).reason).toBe('report.too_early')
  })
})

describe('parseLateChargeReport', () => {
  it.each([
    ['another booking', { ...done, commitmentId: `0x${'c2'.repeat(32)}` }],
    ['a no-show report', { ...done, kind: 'noShow' }],
    ['an amount that is no whole number', { ...done, amount: '5.5' }],
    ['a transaction that is no hash', { ...done, transaction: '0x12' }],
    ['an outcome it does not know', { ...done, outcome: 'paid' }],
  ])('refuses an answer about %s', (_, answer) => {
    expect(parseLateChargeReport(answer, ID)).toEqual({ ok: false, reason: 'message.invalid' })
  })
})
