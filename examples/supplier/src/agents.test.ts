import type { AddressInfo } from 'node:net'
import {
  digestOf,
  parseAgreementSignature,
  parseSupplierProfile,
  parseSupplierRefusal,
  SUPPLIER_ADAPTER_PATHS,
  TESTNET_DEMO_PROFILE,
  termsAgreementTypedData,
  toWire,
} from '@avow-finance/spec'
import { isAddressEqual, recoverAddress } from 'viem'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AgentDeps, agentServer, signAgreement } from './agents.js'
import type { SupplierStore } from './store.js'
import {
  agreement,
  CHAIN_ID,
  COMMITMENT,
  DOMAIN,
  NOW,
  SALT,
  supplierAccount,
  supplierKey,
  tempStore,
  terms,
} from './test/fixtures.js'

let store: SupplierStore
let remove: () => void
let deps: AgentDeps
let factoryMade: boolean

beforeEach(() => {
  ;({ store, remove } = tempStore())
  factoryMade = true
  deps = {
    profile: {
      businessId: 'biz_supplier',
      account: supplierAccount.address,
      payee: supplierAccount.address,
      signingKey: supplierKey.address,
    },
    rules: {
      chainId: CHAIN_ID,
      businessId: 'biz_supplier',
      maxReserve: 1_000_000_000n,
      profile: TESTNET_DEMO_PROFILE,
      minTimeToAccept: 60n,
    },
    store,
    signingKey: supplierKey,
    isLock: async () => factoryMade,
    now: () => NOW,
    log: () => {},
  }
})
afterEach(() => remove())

/** The offer as an agent's SDK sends it, through JSON. */
const offer = (change: Record<string, unknown> = {}) =>
  JSON.parse(JSON.stringify(toWire({ agreement, terms, salt: SALT, domain: DOMAIN, ...change })))

describe('signing an agent’s terms agreement', () => {
  it('signs with the signing key and records the booking before it answers', async () => {
    const answer = await signAgreement(deps, offer())
    expect(answer.status).toBe(200)
    const { signature } = answer.body as { signature: `0x${string}` }
    const signer = await recoverAddress({
      hash: digestOf(termsAgreementTypedData(agreement, DOMAIN)),
      signature,
    })
    expect(isAddressEqual(signer, supplierKey.address)).toBe(true)
    expect(store.booking(COMMITMENT)).toMatchObject({ status: 'agreed', signature })
  })

  it('answers the same offer again with the same signature, and refuses another for the commitment', async () => {
    const first = await signAgreement(deps, offer())
    expect(await signAgreement(deps, offer())).toEqual(first)
    const other = await signAgreement(deps, offer({ salt: `0x${'66'.repeat(32)}` }))
    expect(other.status).toBe(409)
    expect(store.bookings()).toHaveLength(1)
  })

  it('refuses terms whose hash isn’t the agreement’s, and records nothing', async () => {
    const answer = await signAgreement(deps, offer({ salt: `0x${'66'.repeat(32)}` }))
    expect(answer).toMatchObject({ status: 422 })
    expect(store.bookings()).toEqual([])
  })

  it('refuses a lock Avow’s factory didn’t make', async () => {
    factoryMade = false
    expect((await signAgreement(deps, offer())).status).toBe(422)
  })

  it('refuses a body that isn’t an offer, saying why as the spec reads a refusal', async () => {
    for (const body of [{ hello: 'there' }, offer({ terms: { template: 'nope' } })]) {
      const answer = await signAgreement(deps, body)
      expect(answer.status).toBe(400)
      expect(parseSupplierRefusal(answer.body)?.error).toContain('the body is no agreement offer')
    }
  })

  it('serves its profile and signs agreements over HTTP, at the routes and in the bodies the spec fixes', async () => {
    const server = agentServer(deps).listen(0)
    await new Promise((resolve) => server.once('listening', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const profile = await fetch(`${url}${SUPPLIER_ADAPTER_PATHS.profile}`)
      expect(parseSupplierProfile(await profile.json())).toEqual({
        ok: true,
        value: {
          businessId: deps.profile.businessId,
          account: deps.profile.account.toLowerCase(),
          payee: deps.profile.payee.toLowerCase(),
          signingKey: deps.profile.signingKey.toLowerCase(),
        },
      })
      const signed = await fetch(`${url}${SUPPLIER_ADAPTER_PATHS.agreements}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(offer()),
      })
      expect(signed.status).toBe(200)
      expect(parseAgreementSignature(await signed.json()).ok).toBe(true)
      const broken = await fetch(`${url}${SUPPLIER_ADAPTER_PATHS.agreements}`, {
        method: 'POST',
        body: '{',
      })
      expect(broken.status).toBe(400)
      expect(parseSupplierRefusal(await broken.json())).not.toBeNull()
      expect((await fetch(`${url}/other`)).status).toBe(404)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
