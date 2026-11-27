import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Address } from 'viem'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkCommitment, type LocalDeps, localHostnames, localServer } from './local.js'
import type { Booking, SupplierStore } from './store.js'
import {
  agreedBooking,
  approval,
  COMMITMENT,
  LOCK,
  reservedChain,
  supplierAccount,
  tempStore,
} from './test/fixtures.js'

let store: SupplierStore
let remove: () => void
beforeEach(() => {
  ;({ store, remove } = tempStore())
})
afterEach(() => remove())

const accepted = (): Booking => ({ ...agreedBooking(), status: 'accepted' })

/** What the adapter reads, with the lock holding the reserve in a given state, or holding none. */
async function deps(
  state: 'reserved' | 'accepted' | 'released' | null,
  payee?: Address,
): Promise<LocalDeps> {
  const chain = reservedChain()
  const held = await chain.backing(LOCK, COMMITMENT, 'buyer')
  chain.setBacking(
    LOCK,
    COMMITMENT,
    'buyer',
    state === null || held === null ? null : { ...held, state, payee: payee ?? held.payee },
  )
  return {
    store,
    chain,
    payee: supplierAccount.address,
    decimals: 6,
    hostnames: localHostnames('127.0.0.1'),
    log: () => {},
  }
}

describe('checking a commitment for the supplier', () => {
  it('answers null for a commitment the adapter holds no booking for', async () => {
    expect(await checkCommitment(await deps('reserved'), COMMITMENT)).toBeNull()
  })

  it('says to grant only once the adapter accepted, the lock holds the acceptance and it pays this supplier', async () => {
    store.put(agreedBooking())
    const reserved = await checkCommitment(await deps('reserved'), COMMITMENT)
    expect(reserved).toMatchObject({ status: 'agreed', grant: false })
    expect(reserved?.onChain).toMatchObject({ state: 'reserved', paysYou: true })
    expect(Number(reserved?.onChain?.reserveDollars) * 1_000_000).toBe(Number(approval.amount))

    store.put(accepted())
    expect(await checkCommitment(await deps('accepted'), COMMITMENT)).toMatchObject({
      status: 'accepted',
      grant: true,
    })
    const elsewhere = await checkCommitment(await deps('accepted', LOCK), COMMITMENT)
    expect(elsewhere).toMatchObject({ grant: false, onChain: { paysYou: false } })
    expect(await checkCommitment(await deps('released'), COMMITMENT)).toMatchObject({
      grant: false,
    })
  })

  it('names the business that booked, which the webhook leaves out', async () => {
    const booking = agreedBooking()
    store.put(booking)
    const check = await checkCommitment(await deps(null), COMMITMENT)
    expect(check?.buyerBusinessId).toBe(booking.agreement.buyerBusinessId)
  })

  it('says the lock holds nothing yet before the reserve arrives', async () => {
    store.put(agreedBooking())
    expect(await checkCommitment(await deps(null), COMMITMENT)).toMatchObject({
      grant: false,
      onChain: null,
    })
  })
})

describe("the adapter's local port", () => {
  it('answers a check at /commitments/<id>, a 404 for an unknown one, and its health', async () => {
    store.put(accepted())
    const server = localServer(await deps('accepted')).listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const found = await fetch(
        `${base}/commitments/${COMMITMENT.toUpperCase().replace('0X', '0x')}`,
      )
      expect(found.status).toBe(200)
      expect(await found.json()).toMatchObject({ commitmentId: COMMITMENT, grant: true })
      const unknown = await fetch(`${base}/commitments/0x${'ee'.repeat(32)}`)
      expect(unknown.status).toBe(404)
      expect((await fetch(`${base}/commitments/nope`)).status).toBe(404)
      expect(await (await fetch(`${base}/health`)).json()).toEqual({ status: 'ok' })
    } finally {
      server.close()
    }
  })

  it('refuses a request that names another host, as a page on another site would after rebinding its name', async () => {
    store.put(accepted())
    const server = localServer(await deps('accepted')).listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    const port = (server.address() as AddressInfo).port
    const statusFor = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request(
          { host: '127.0.0.1', port, path: '/health', headers: { host } },
          (res) => {
            res.resume()
            resolve(res.statusCode ?? 0)
          },
        )
        req.on('error', reject)
        req.end()
      })
    try {
      expect(await statusFor('evil.example')).toBe(403)
      expect(await statusFor(`evil.example:${port}`)).toBe(403)
      expect(await statusFor(`localhost:${port}`)).toBe(200)
      expect(await statusFor('[::1]')).toBe(200)
    } finally {
      server.close()
    }
  })

  it('takes the loopback names and the address it listens on, and no address that means every one', () => {
    expect(localHostnames('127.0.0.1')).toEqual(['localhost', '127.0.0.1', '[::1]'])
    expect(localHostnames('10.0.0.5')).toContain('10.0.0.5')
    expect(localHostnames('0.0.0.0')).not.toContain('0.0.0.0')
    expect(localHostnames('fd00::5')).toContain('[fd00::5]')
  })
})
