import type { AddressInfo } from 'node:net'
import { digestOf, TESTNET_DEMO_PROFILE, termsAgreementTypedData, toWire } from '@avow-finance/spec'
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

  it('refuses a body that isn’t an offer', async () => {
    expect((await signAgreement(deps, { hello: 'there' })).status).toBe(400)
    expect((await signAgreement(deps, offer({ terms: { template: 'nope' } }))).status).toBe(400)
  })

  it('serves its profile and signs agreements over HTTP', async () => {
    const server = agentServer(deps).listen(0)
    await new Promise((resolve) => server.once('listening', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      expect(await (await fetch(`${url}/profile`)).json()).toEqual(deps.profile)
      const signed = await fetch(`${url}/agreements`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(offer()),
      })
      expect(signed.status).toBe(200)
      const broken = await fetch(`${url}/agreements`, { method: 'POST', body: '{' })
      expect(broken.status).toBe(400)
      expect((await fetch(`${url}/other`)).status).toBe(404)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
