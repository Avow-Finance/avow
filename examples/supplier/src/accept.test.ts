import { type Call, SendError } from '@avow-finance/sdk'
import { MemoryReplayGuard } from '@avow-finance/spec'
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
let sendDoes: 'land' | 'fail' | 'unknown'
let answers: number

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
      if (sendDoes === 'fail')
        throw new SendError('it reverted', 'failed', { hashes: [HASH], signings: 1 })
      if (sendDoes === 'unknown') {
        throw new SendError('no receipt came', 'unknown', { hashes: [HASH], signings: 1 })
      }
      lock.state = 'accepted'
      return {}
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

  it("checks Avow's authorization, holds capacity, and sends the acceptance the verifier built to the lock", async () => {
    expect(await advance(deps, put())).toBe('accepted')
    expect(status()).toBe('accepted')
    expect(sent).toHaveLength(1)
    const call = sent[0] as Call
    expect(call.to.toLowerCase()).toBe(LOCK)
    const { args } = decodeFunctionData({ abi: ACCEPT_ABI, data: call.data })
    expect(args[0].commitmentId).toBe(COMMITMENT)
    expect(logged.some((l) => l.startsWith('holding capacity'))).toBe(true)
  })

  it('sends again after a failed send, without granting capacity twice', async () => {
    sendDoes = 'fail'
    expect(await advance(deps, put())).toBe('granted')
    expect(store.booking(COMMITMENT)?.sent).toBeUndefined()
    sendDoes = 'land'
    // The verifier's replay guard refuses a second grant, so this pass has to skip it.
    expect(await advance(deps, store.booking(COMMITMENT) as Booking)).toBe('accepted')
    expect(sent).toHaveLength(2)
  })

  it('leaves a send whose outcome is unknown until the lock or the chain settles it', async () => {
    sendDoes = 'unknown'
    await expect(advance(deps, put())).rejects.toThrow('no receipt came')
    expect(status()).toBe('accepting')
    lock.state = 'reserved'
    expect(await advance(deps, store.booking(COMMITMENT) as Booking)).toBe('accepting')
    lock.finalized = NOW + 26n
    sendDoes = 'land'
    expect(await advance(deps, store.booking(COMMITMENT) as Booking)).toBe('accepted')
    expect(sent).toHaveLength(2)
  })

  it('takes an acceptance the lock already holds, whatever sent it', async () => {
    put({ status: 'accepting', sent: { hash: HASH, validBefore: String(NOW + 25n) } })
    lock.state = 'accepted'
    expect(await advance(deps, store.booking(COMMITMENT) as Booking)).toBe('accepted')
    expect(sent).toEqual([])
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
    lock.state = 'accepted'
    expect(await advance(deps, put({ status: 'granted' }))).toBe('accepted')
  })

  it("never accepts when the verifier refuses Avow's authorization", async () => {
    deps.config = { ...acceptanceConfig, avowKeys: [supplierKey.address] }
    expect(await advance(deps, put())).toBe('agreed')
    expect(sent).toEqual([])
    expect(logged.some((l) => l.includes('the verifier refused'))).toBe(true)
  })

  it('moves every open booking on, past one that fails', async () => {
    put()
    store.put({ ...agreedBooking(), commitmentId: `0x${'ee'.repeat(32)}`, terms: { broken: true } })
    await advanceAll(deps)
    expect(status()).toBe('accepted')
    expect(logged.some((l) => l.includes("won't parse"))).toBe(true)
  })
})
