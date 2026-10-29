import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accountSigner, signMandate } from '@avow-finance/sdk'
import {
  type AvowDomain,
  type Mandate,
  type Signed,
  TEMPO_MODERATO,
  toWire,
} from '@avow-finance/spec'
import { type Address, getAddress, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { quickstartMandate } from './plan.js'
import { type BuyerSetup, BuyerStore } from './store.js'

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

/** What Avow records when it enrolls the agent a mandate names. */
const enrollmentFor = (mandate: Signed<Mandate>) => ({
  businessId: 'biz_buyer',
  agentId: 'agt_quickstart',
  agentKey: mandate.message.agentKey.toLowerCase() as Address,
  mandateHash: `0x${'cd'.repeat(32)}` as Hex,
})

/** The same value apart from the letter case of its hex, which the store reads in lower case. */
const caseless = (value: unknown) => JSON.stringify(toWire(value)).toLowerCase()

let dir: string
let store: BuyerStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avow-buyer-'))
  store = new BuyerStore(dir)
})
afterEach(() => rmSync(dir, { recursive: true }))

const write = (name: string, value: unknown) =>
  writeFileSync(
    join(dir, name),
    typeof value === 'string' ? value : JSON.stringify(toWire(value), null, 2),
  )

describe("the business's state directory", () => {
  it('makes the keys once and reads them back, and refuses a key file that holds anything else', () => {
    expect(store.keys()).toBeNull()
    const keys = store.makeKeys()
    expect(store.keys()).toEqual(keys)
    expect(() => store.makeKeys()).toThrow('already holds')
    for (const broken of [{ rootKey: keys.rootKey }, { ...keys, agentKey: '0x1234' }, '{']) {
      write('keys.json', broken)
      expect(() => store.keys()).toThrow(join(dir, 'keys.json'))
      // A broken key file is never written over.
      expect(() => store.makeKeys()).toThrow(join(dir, 'keys.json'))
    }
  })

  it('saves the setup as JSON and reads back the mandate and enrollment it holds, parsed', async () => {
    expect(store.setup()).toEqual({})
    const mandate = await signedMandate(LOCK)
    const enrollment = enrollmentFor(mandate)
    store.saveSetup({ lock: LOCK })
    store.saveSetup({ mandate, keyAuthorizedIn: KEY_TX })
    store.saveSetup({ enrollment })
    const setup = store.setup()
    expect(setup.lock).toBe(LOCK)
    expect(setup.keyAuthorizedIn).toBe(KEY_TX)
    expect(setup.enrollment).toEqual(enrollment)
    expect(caseless(setup.mandate)).toBe(caseless(mandate))
    expect(setup.mandate?.message.capPerCommitment).toBe(500_000_000n)
  })

  it("keeps the mandate's lock once enroll saves one, so init with another factory changes nothing", async () => {
    // init, then enroll.
    store.saveSetup({ lock: LOCK })
    const mandate = await signedMandate(LOCK)
    store.saveSetup({ mandate, keyAuthorizedIn: KEY_TX })
    store.saveSetup({ enrollment: enrollmentFor(mandate) })
    const file = readFileSync(join(dir, 'setup.json'), 'utf8')
    // init again with another factory, whose lock the saved mandate isn't signed for.
    const refusal = `${dir} holds a mandate signed for the lock ${LOCK}, so it keeps that lock and can't take ${OTHER_LOCK}. Use a new STATE_DIR to start over.`
    expect(() => store.checkLock(OTHER_LOCK)).toThrow(refusal)
    expect(() => store.saveSetup({ lock: OTHER_LOCK })).toThrow(refusal)
    expect(readFileSync(join(dir, 'setup.json'), 'utf8')).toBe(file)
    // Every command still reads the setup, and init with the original factory still works. The
    // factory gives the lock's address checksummed, which is the same lock.
    expect(store.setup().lock).toBe(LOCK)
    store.checkLock(getAddress(LOCK))
    expect(store.saveSetup({ lock: getAddress(LOCK) }).lock).toBe(LOCK)
    const setup = store.setup()
    expect(caseless(setup.mandate)).toBe(caseless(mandate))
    expect(setup.keyAuthorizedIn).toBe(KEY_TX)
    expect(setup.enrollment).toEqual(enrollmentFor(mandate))
  })

  it('takes another lock until a mandate is saved', () => {
    store.saveSetup({ lock: LOCK })
    store.checkLock(OTHER_LOCK)
    expect(store.saveSetup({ lock: OTHER_LOCK }).lock).toBe(OTHER_LOCK)
    expect(store.setup().lock).toBe(OTHER_LOCK)
  })

  it('refuses to save a change that a later read would refuse, and writes nothing', async () => {
    const path = join(dir, 'setup.json')
    // A mandate with no lock to be signed for.
    const mandate = await signedMandate(LOCK)
    expect(() => store.saveSetup({ mandate })).toThrow(
      `${path} wasn't changed, since with this change it holds a mandate but no lock`,
    )
    expect(existsSync(path)).toBe(false)
    store.saveSetup({ lock: LOCK })
    const file = readFileSync(path, 'utf8')
    const changes: [BuyerSetup, string][] = [
      [
        { mandate: await signedMandate(OTHER_LOCK) },
        "holds a mandate that doesn't parse (message.wrong_contract)",
      ],
      [
        { enrollment: { agentId: 'agt_quickstart' } as never },
        "holds an enrollment that doesn't parse",
      ],
      [{ keyAuthorizedIn: '0x1234' }, "doesn't hold the business's setup"],
    ]
    for (const [change, says] of changes) {
      expect(() => store.saveSetup(change), says).toThrow(
        `${path} wasn't changed, since with this change it ${says}`,
      )
      expect(readFileSync(path, 'utf8'), says).toBe(file)
    }
  })

  it("refuses a setup file that doesn't hold what it should", async () => {
    const mandate = toWire(await signedMandate(LOCK))
    const broken: [unknown, string][] = [
      ['not json', "isn't JSON"],
      [{ lock: LOCK, extra: true }, "doesn't hold the business's setup"],
      [{ lock: '0x1234' }, "doesn't hold the business's setup"],
      [{ mandate }, 'holds a mandate but no lock'],
      [{ lock: OTHER_LOCK, mandate }, "doesn't parse (message.wrong_contract)"],
      [{ lock: LOCK, mandate: { ...(mandate as object), schemaVersion: '9' } }, 'schema_unknown'],
      [{ lock: LOCK, enrollment: { agentId: 'agt_quickstart' } }, 'an enrollment that'],
    ]
    for (const [file, says] of broken) {
      write('setup.json', file)
      expect(() => store.setup(), says).toThrow(says)
    }
  })
})
