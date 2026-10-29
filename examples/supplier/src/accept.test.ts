import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Call, SendError } from '@avow-finance/sdk'
import { MemoryReplayGuard, toWire } from '@avow-finance/spec'
import { ACCEPT_ABI } from '@avow-finance/verifier'
import { decodeFunctionData, type Hex, keccak256, stringToHex } from 'viem'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AcceptDeps, advance, advanceAll } from './accept.js'
import type { Booking, SupplierStore } from './store.js'
import {
  acceptanceConfig,
  agreedBooking,
  authorized,
  COMMITMENT,
  LOCK,
  NOW,
  reservedChain,
  START,
  supplierKey,
  tempStore,
} from './test/fixtures.js'

const HASH: Hex = keccak256(stringToHex('the acceptance transaction'))

let store: SupplierStore
let remove: () => void
let deps: AcceptDeps
let logged: string[]
let sent: Call[]
/** What the lock shows for the commitment, and what each send does. */
let lock: { state: string | null; finalized: bigint }
let sendDoes: 'land' | 'fail' | 'unknown' | 'revert'
let answers: number
/** The lines saying the supplier granted a booking's capacity. */
const grants = () => logged.filter((l) => l.startsWith('granting'))

beforeEach(() => {
  ;({ store, remove } = tempStore())
  logged = []
  sent = []
  lock = { state: 'reserved', finalized: NOW }
  sendDoes = 'land'
  answers = 0
  deps = {
    store,
    config: acceptanceConfig,
    chain: reservedChain(),
    replay: new MemoryReplayGuard(),
    authorize: async () => authorized(BigInt(++answers)),
    signingKey: supplierKey,
    send: async (call, onSent) => {
      sent.push(call)
      // The record has to name the hash before the bytes go anywhere.
      await onSent(HASH, NOW + 25n)
      expect(store.booking(COMMITMENT)?.sent?.hash).toBe(HASH)
      // Nothing is granted while the acceptance hasn't landed.
      expect(grants()).toEqual([])
      if (sendDoes === 'fail')
        throw new SendError('it reverted', 'failed', { hashes: [HASH], signings: 1 })
      if (sendDoes === 'unknown') {
        throw new SendError('no receipt came', 'unknown', { hashes: [HASH], signings: 1 })
      }
      if (sendDoes === 'revert') return { status: 'reverted' }
      lock.state = 'accepted'
      return { status: 'success' }
    },
    lockState: async () => lock.state,
    finalizedTime: async () => lock.finalized,
    now: () => NOW,
    log: (line) => logged.push(line),
  }
})
afterEach(() => remove())

const put = (change: Partial<Booking> = {}) => {
  const b = { ...agreedBooking(), ...change } as Booking
  store.put(b)
  return b
}
const status = () => store.booking(COMMITMENT)?.status

describe("the supplier's acceptance of a booking", () => {
  it('waits quietly while the reserve is not funded yet', async () => {
    deps.authorize = async () => ({ ok: false, reason: 'chain.reserve_missing' })
    expect(await advance(deps, put())).toBe('agreed')
    expect(logged).toEqual([])
    expect(sent).toEqual([])
  })

  it("checks Avow's authorization, holds capacity, sends the acceptance the verifier built, and grants once it lands", async () => {
    expect(await advance(deps, put())).toBe('accepted')
    expect(status()).toBe('accepted')
    expect(sent).toHaveLength(1)
    const call = sent[0] as Call
    expect(call.to.toLowerCase()).toBe(LOCK)
    const { args } = decodeFunctionData({ abi: ACCEPT_ABI, data: call.data })
    expect(args[0].commitmentId).toBe(COMMITMENT)
    // Capacity is held once Avow authorized the booking, and granted only after the receipt.
    const held = logged.findIndex((l) => l.startsWith('holding capacity'))
    const granted = logged.findIndex((l) => l.startsWith('granting'))
    expect(held).toBeGreaterThanOrEqual(0)
    expect(granted).toBeGreaterThan(held)
    expect(grants()).toEqual([
      `granting the capacity held for ${COMMITMENT}, now that the acceptance's receipt shows the lock took it`,
    ])
  })

  it('holds the capacity after a failed send, grants nothing, and sends again', async () => {
    sendDoes = 'fail'
    expect(await advance(deps, put())).toBe('held')
    expect(store.booking(COMMITMENT)?.sent).toBeUndefined()
    expect(grants()).toEqual([])
    sendDoes = 'land'
    // The verifier's replay guard refuses a second pass, so a held booking skips it.
    expect(await advance(deps, store.booking(COMMITMENT) as Booking)).toBe('accepted')
    expect(sent).toHaveLength(2)
    expect(grants()).toHaveLength(1)
  })

  it("grants nothing when the acceptance's receipt shows it reverted", async () => {
    sendDoes = 'revert'
    expect(await advance(deps, put())).toBe('held')
    expect(grants()).toEqual([])
    expect(logged.some((l) => l.includes('reverted'))).toBe(true)
  })

  it('leaves a send whose outcome is unknown until the lock or the chain settles it', async () => {
    sendDoes = 'unknown'
    await expect(advance(deps, put())).rejects.toThrow('no receipt came')
    expect(status()).toBe('accepting')
    lock.state = 'reserved'
    expect(await advance(deps, store.booking(COMMITMENT) as Booking)).toBe('accepting')
    expect(grants()).toEqual([])
    lock.finalized = NOW + 26n
    sendDoes = 'land'
    expect(await advance(deps, store.booking(COMMITMENT) as Booking)).toBe('accepted')
    expect(sent).toHaveLength(2)
    expect(grants()).toHaveLength(1)
  })

  it('takes an acceptance the lock already holds, whatever sent it, and grants then', async () => {
    put({ status: 'accepting', sent: { hash: HASH, validBefore: NOW + 25n } })
    lock.state = 'accepted'
    expect(await advance(deps, store.booking(COMMITMENT) as Booking)).toBe('accepted')
    expect(sent).toEqual([])
    expect(grants()).toEqual([
      `granting the capacity held for ${COMMITMENT}, now that the lock shows the acceptance`,
    ])
  })

  it('sends again after a restart that recorded no transaction, since nothing went out', async () => {
    put({ status: 'accepting' })
    expect(await advance(deps, store.booking(COMMITMENT) as Booking)).toBe('accepted')
    expect(sent).toHaveLength(1)
  })

  it('lets a booking lapse once its acceptance deadline passes with no reserve', async () => {
    deps.now = () => START
    expect(await advance(deps, put())).toBe('lapsed')
    expect(sent).toEqual([])
  })

  it('takes an Avow answer that the reserve is accepted once the lock shows it', async () => {
    deps.authorize = async () => ({ ok: false, reason: 'chain.reserve_accepted' })
    lock.state = 'reserved'
    expect(await advance(deps, put({ status: 'held' }))).toBe('held')
    expect(grants()).toEqual([])
    lock.state = 'accepted'
    expect(await advance(deps, store.booking(COMMITMENT) as Booking)).toBe('accepted')
    expect(grants()).toHaveLength(1)
  })

  it("never holds, accepts or grants when the verifier refuses Avow's authorization", async () => {
    deps.config = { ...acceptanceConfig, avowKeys: [supplierKey.address] }
    expect(await advance(deps, put())).toBe('agreed')
    expect(sent).toEqual([])
    expect(logged.some((l) => l.includes('the verifier refused'))).toBe(true)
    expect(logged.some((l) => l.startsWith('holding capacity'))).toBe(false)
    expect(grants()).toEqual([])
  })

  it('moves every open booking on, past one whose file the store refuses', async () => {
    put()
    const other: Hex = `0x${'ee'.repeat(32)}`
    const broken = toWire({ ...agreedBooking(), commitmentId: other }) as Record<string, unknown>
    broken.agreement = { ...(broken.agreement as object), commitmentId: other }
    broken.terms = { broken: true }
    writeFileSync(join(store.dir, 'bookings', `${other}.json`), JSON.stringify(broken))
    await advanceAll(deps)
    expect(status()).toBe('accepted')
    const refused = logged.filter((l) => l.startsWith(`booking ${other}: `))
    expect(refused).toHaveLength(1)
    expect(refused[0]).toContain("holds terms that don't parse (terms.version_unknown)")
  })
})
