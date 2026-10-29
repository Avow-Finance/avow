import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accountSigner, signMandate } from '@avow-finance/sdk'
import { type AvowDomain, TEMPO_MODERATO } from '@avow-finance/spec'
import type { Address, Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type InitDeps, initBusiness } from './init.js'
import { quickstartMandate } from './plan.js'
import { BuyerStore } from './store.js'

// Every key is generated for the run, and every state directory is removed after its test.
const LOCK: Address = '0x00000000000000000000000000000000000010c4'
const OTHER_LOCK: Address = '0x00000000000000000000000000000000000010c5'
const KEY_TX: Hex = `0x${'ab'.repeat(32)}`
const root = privateKeyToAccount(generatePrivateKey())

async function signedMandate(lock: Address) {
  const d: AvowDomain = { chainId: TEMPO_MODERATO, verifyingContract: lock }
  const mandate = quickstartMandate({
    businessId: 'biz_buyer',
    agentId: 'agt_quickstart',
    account: root.address,
    agentKey: privateKeyToAccount(generatePrivateKey()).address,
    supplier: {
      businessId: 'biz_supplier',
      account: '0x00000000000000000000000000000000000000c1',
      payee: '0x00000000000000000000000000000000000000c1',
      signingKey: '0x00000000000000000000000000000000000000c3',
    },
    token: '0x20c0000000000000000000000000000000000001',
    reserve: 500_000_000n,
    open: 3n,
    now: 1_800_000_000n,
  })
  return signMandate(mandate, d, accountSigner(root.address, root))
}

let dir: string
let store: BuyerStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avow-buyer-init-'))
  store = new BuyerStore(dir)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** The chain and faucet calls `init` makes, recorded in order, with the factory giving `lock`. */
function chainGiving(lock: Address, created: boolean) {
  const calls: string[] = []
  const deps: InitDeps = {
    store,
    account: root.address,
    lockAddress: async () => {
      calls.push('lockAddress')
      return lock
    },
    fundFees: async () => {
      calls.push('fundFees')
    },
    lockExists: async () => {
      calls.push('lockExists')
      return created
    },
    createLock: async () => {
      calls.push('createLock')
    },
    log: () => {},
  }
  return { deps, calls }
}

describe("the buyer's init", () => {
  it('funds the fees, creates the lock once and saves it', async () => {
    const fresh = chainGiving(LOCK, false)
    expect(await initBusiness(fresh.deps)).toBe(LOCK)
    expect(fresh.calls).toEqual(['lockAddress', 'fundFees', 'lockExists', 'createLock'])
    expect(store.setup().lock?.toLowerCase()).toBe(LOCK.toLowerCase())
    const again = chainGiving(LOCK, true)
    await initBusiness(again.deps)
    expect(again.calls).toEqual(['lockAddress', 'fundFees', 'lockExists'])
  })

  it("refuses another factory's lock once a mandate is saved, before it asks the faucet or sends anything", async () => {
    await initBusiness(chainGiving(LOCK, false).deps)
    store.saveSetup({ mandate: await signedMandate(LOCK), keyAuthorizedIn: KEY_TX })
    const before = readFileSync(join(dir, 'setup.json'), 'utf8')
    const other = chainGiving(OTHER_LOCK, false)
    await expect(initBusiness(other.deps)).rejects.toThrow('STATE_DIR')
    expect(other.calls).toEqual(['lockAddress'])
    expect(readFileSync(join(dir, 'setup.json'), 'utf8')).toBe(before)
    // The original factory still works.
    const same = chainGiving(LOCK, true)
    expect(await initBusiness(same.deps)).toBe(LOCK)
  })
})
